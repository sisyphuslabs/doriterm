/** The part of a Bun socket a writer needs: `write` returns how many bytes the socket took. */
export interface WritableSocket {
  write(data: Uint8Array): number;
  end(): void;
}

/**
 * What a socket still owes its peer. A Bun socket takes only what fits its send buffer and keeps none of the rest, so
 * the rest waits here for `drain`, in order (#2387). The control socket and the line socket share it (#2515).
 */
export class SocketWriter {
  readonly #queue: Uint8Array[] = [];
  #queuedBytes = 0;
  #ending = false;

  /** Bytes queued that the socket has not taken yet. */
  get queuedBytes(): number {
    return this.#queuedBytes;
  }

  /** Queues `bytes` after anything still waiting and writes what the socket takes now; `end` closes it once all is out. */
  send(socket: WritableSocket, bytes: Uint8Array, end = false): void {
    if (this.#ending) return;
    this.#queue.push(bytes);
    this.#queuedBytes += bytes.byteLength;
    this.#ending = end;
    this.flush(socket);
  }

  /** Writes what the socket takes now (call it on `drain`), and ends the socket once all is out after an asked end. */
  flush(socket: WritableSocket): void {
    for (let head = this.#queue[0]; head !== undefined; head = this.#queue[0]) {
      const taken = Math.min(Math.max(0, socket.write(head)), head.byteLength);
      this.#queuedBytes -= taken;
      if (taken < head.byteLength) {
        this.#queue[0] = head.subarray(taken);
        return;
      }
      this.#queue.shift();
    }
    if (this.#ending) socket.end();
  }

  /** Drops everything still queued without writing it. */
  clear(): void {
    this.#queue.length = 0;
    this.#queuedBytes = 0;
  }
}
