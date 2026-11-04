const HEAD_END = "\r\n\r\n";
const CLOSE_OPCODE = 0x8;

function joined(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right;
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

/**
 * Reads the close codes the relay sends on one plain `ws://` connection, from the raw server-to-host bytes a tap
 * forwards: the HTTP head first, then unmasked WebSocket frames. Payloads of other frames are skipped, not buffered.
 */
export class CloseFrameReader {
  readonly codes: number[] = [];
  #head = "";
  #inFrames = false;
  #pending: Uint8Array = new Uint8Array(0);
  #skip = 0;

  feed(bytes: Uint8Array): void {
    let data = bytes;
    if (!this.#inFrames) {
      this.#head += Buffer.from(data).toString("latin1");
      const end = this.#head.indexOf(HEAD_END);
      if (end < 0) return;
      this.#inFrames = true;
      data = Buffer.from(this.#head.slice(end + HEAD_END.length), "latin1");
      this.#head = "";
    }
    const skipped = Math.min(this.#skip, data.length);
    this.#skip -= skipped;
    this.#pending = joined(this.#pending, data.subarray(skipped));
    let more = true;
    while (more) more = this.#skip === 0 && this.#frame();
  }

  /** Consumes one frame from the pending bytes; false when it is not complete yet. */
  #frame(): boolean {
    const bytes = this.#pending;
    if (bytes.length < 2) return false;
    const opcode = (bytes[0] ?? 0) & 0x0f;
    const short = (bytes[1] ?? 0) & 0x7f;
    const extra = short === 126 ? 2 : short === 127 ? 8 : 0;
    if (bytes.length < 2 + extra) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = short === 126 ? view.getUint16(2) : short === 127 ? Number(view.getBigUint64(2)) : short;
    const header = 2 + extra;
    if (opcode === CLOSE_OPCODE) {
      if (bytes.length < header + Math.min(length, 2)) return false;
      if (length >= 2) this.codes.push(view.getUint16(header));
    }
    const available = Math.min(length, bytes.length - header);
    this.#skip = length - available;
    this.#pending = bytes.subarray(header + available);
    return true;
  }
}
