const ESC = 0x1b;
const CSI = 0x5b;
const QUESTION = 0x3f;
const SEMICOLON = 0x3b;
const H = 0x68;
const L = 0x6c;
const C = 0x63;
const ZERO = 0x30;
const NINE = 0x39;
/** Synchronized output (DECSET 2026): a program brackets a frame with it so the terminal draws the frame whole. */
const SYNCHRONIZED_OUTPUT = 2026;
/**
 * How much of an unfinished `ESC [ ? Ps ; ... h` is kept across chunks: only digits and semicolons grow it, so this
 * holds a list of some sixty modes, past any a program sends; a longer run of them is not a mode set we read.
 */
const MAX_CARRY = 256;

/**
 * Follows a terminal's output and tells whether it is inside a synchronized update: after `ESC [ ? 2026 h` and before
 * `ESC [ ? 2026 l` (or a full reset, RIS `ESC c`, which ends it too). A sequence split across chunks is joined.
 */
export class SynchronizedUpdate {
  #open = false;
  #opened = false;
  #carry: Uint8Array = new Uint8Array(0);

  get open(): boolean {
    return this.#open;
  }

  /** Whether the last {@link advance} read an update opening, even one it then read closing in the same chunk. */
  get opened(): boolean {
    return this.#opened;
  }

  /**
   * Reads `chunk` in order and returns how many of its bytes were read: all of them, or fewer when an open update ends
   * inside it, up to and including the sequence that ends it, so the caller can treat what follows as outside.
   */
  advance(chunk: Uint8Array): number {
    const carried = this.#carry.length;
    const bytes = carried === 0 ? chunk : join(this.#carry, chunk);
    this.#carry = new Uint8Array(0);
    this.#opened = false;
    for (let index = 0; index < bytes.length; index++) {
      if (bytes[index] !== ESC) continue;
      const [mode, end] = read(bytes, index);
      if (end === -1) {
        if (bytes.length - index <= MAX_CARRY) this.#carry = bytes.slice(index);
        return chunk.length;
      }
      if (mode === null) continue;
      const wasOpen = this.#open;
      this.#open = mode;
      if (mode && !wasOpen) this.#opened = true;
      if (wasOpen && !mode) return Math.max(0, end - carried);
      index = end - 1;
    }
    return chunk.length;
  }
}

function join(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * The sequence at an ESC: whether it opens (true) or ends (false) a synchronized update, or neither (null), and the
 * index just past it; -1 when the bytes end before the sequence does.
 */
function read(bytes: Uint8Array, at: number): [boolean | null, number] {
  const next = bytes[at + 1];
  if (next === undefined) return [null, -1];
  if (next === C) return [false, at + 2];
  if (next !== CSI) return [null, at + 1];
  if (bytes[at + 2] === undefined) return [null, -1];
  if (bytes[at + 2] !== QUESTION) return [null, at + 2];
  const params: number[] = [];
  let value = 0;
  for (let index = at + 3; index < bytes.length; index++) {
    const byte = bytes[index] ?? 0;
    if (byte >= ZERO && byte <= NINE) value = value * 10 + (byte - ZERO);
    else if (byte === SEMICOLON) {
      params.push(value);
      value = 0;
    } else {
      params.push(value);
      if ((byte !== H && byte !== L) || !params.includes(SYNCHRONIZED_OUTPUT)) return [null, index + 1];
      return [byte === H, index + 1];
    }
  }
  return [null, -1];
}
