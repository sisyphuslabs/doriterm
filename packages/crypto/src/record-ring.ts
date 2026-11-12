/**
 * The transport records a side keeps after sending them, so a resume can send the peer the ones it never got. Bounded in
 * bytes: the peer is at most one relay credit window (512 KiB) behind what was sent, so this cap covers it with room,
 * and a peer further behind than the ring reaches cannot be resumed and starts a session anew.
 */
export const RECORD_RING_BYTES = 1024 * 1024;

export class RecordRing {
  readonly #cap: number;
  readonly #records: Uint8Array[] = [];
  /** The sequence number of `#records[0]`. */
  #first = 0;
  #bytes = 0;

  constructor(cap = RECORD_RING_BYTES) {
    this.#cap = cap;
  }

  /** The sequence number the next record pushed gets: how many have been pushed so far. */
  get next(): number {
    return this.#first + this.#records.length;
  }

  /** The oldest sequence number still held. */
  get first(): number {
    return this.#first;
  }

  get bytes(): number {
    return this.#bytes;
  }

  /** Keeps `record` as the next sequence number; returns how many of the oldest records it pushed out. */
  push(record: Uint8Array): number {
    this.#records.push(record);
    this.#bytes += record.byteLength;
    let evicted = 0;
    while (this.#bytes > this.#cap && this.#records.length > 1) {
      const oldest = this.#records.shift();
      if (oldest === undefined) break;
      this.#bytes -= oldest.byteLength;
      this.#first += 1;
      evicted += 1;
    }
    return evicted;
  }

  /** The records from sequence number `from` on, in order; undefined when `from` is older than the ring holds or ahead of it. */
  from(from: number): readonly Uint8Array[] | undefined {
    if (from < this.#first || from > this.next) return undefined;
    return this.#records.slice(from - this.#first);
  }
}
