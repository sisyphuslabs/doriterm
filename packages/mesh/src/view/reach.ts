// The reachability of a DAG as one bitset per record. Bitsets are indexed by arrival, so a grown record set extends
// them instead of rebuilding them.

import { DagError } from "./dag-error.ts";

export type Bits = Uint32Array;

export const bitAt = (bits: Bits, i: number): boolean => ((bits[i >>> 5] ?? 0) & (1 << (i & 31))) !== 0;

const setBit = (bits: Bits, i: number): void => {
  bits[i >>> 5] = (bits[i >>> 5] ?? 0) | (1 << (i & 31));
};

/**
 * A past-closed set of one Reach as its arrival bits: membership and size, n/32 words instead of a Set of ids. Records
 * appended later are never in it (their bits lie past its words), so it stays exact as the history grows.
 */
export class PastBits {
  readonly size: number;
  readonly #reach: Reach;
  readonly #bits: Bits;

  constructor(reach: Reach, bits: Bits) {
    this.#reach = reach;
    this.#bits = bits;
    let size = 0;
    for (const word of bits) for (let w = word; w !== 0; w &= w - 1) size++;
    this.size = size;
  }

  has(id: string): boolean {
    const i = this.#reach.arrival(id);
    return i !== undefined && bitAt(this.#bits, i);
  }
}

/** Append-only ancestry: `inPast(of, id)` is `id ∈ past(of)`, in constant time, for every record appended so far. */
export class Reach {
  readonly #arrival = new Map<string, number>();
  #rows: Bits[] = [];
  #words = 8;

  get words(): number {
    return this.#words;
  }

  arrival(id: string): number | undefined {
    return this.#arrival.get(id);
  }

  /** Adds a record whose prev records were all appended before it; a prev that was not is a broken caller. */
  append(id: string, prev: readonly string[]): void {
    const i = this.#rows.length;
    if (i >= this.#words * 32) this.#grow();
    const row = new Uint32Array(this.#words);
    for (const p of prev) {
      const at = this.#arrival.get(p);
      const parent = at === undefined ? undefined : this.#rows[at];
      if (at === undefined || parent === undefined) throw new DagError("dangling prev", `${id} -> ${p} before it`);
      for (let w = 0; w < row.length; w++) row[w] = (row[w] ?? 0) | (parent[w] ?? 0);
      setBit(row, at);
    }
    this.#arrival.set(id, i);
    this.#rows.push(row);
  }

  /** past(id) ∪ {id} as a bitset (a fresh copy). */
  closed(id: string): Bits {
    const at = this.#arrival.get(id) ?? -1;
    const out = Uint32Array.from(this.#rows[at] ?? new Uint32Array(this.#words));
    if (at >= 0) setBit(out, at);
    return out;
  }

  /** past(a) ∩ past(b) as bits. */
  common(a: string, b: string): PastBits {
    const ra = this.#rows[this.#arrival.get(a) ?? -1];
    const rb = this.#rows[this.#arrival.get(b) ?? -1];
    const out = new Uint32Array(Math.min(ra?.length ?? 0, rb?.length ?? 0));
    for (let w = 0; w < out.length; w++) out[w] = (ra?.[w] ?? 0) & (rb?.[w] ?? 0);
    return new PastBits(this, out);
  }

  inPast(of: string, id: string): boolean {
    const row = this.#rows[this.#arrival.get(of) ?? -1];
    const i = this.#arrival.get(id);
    return row !== undefined && i !== undefined && bitAt(row, i);
  }

  #grow(): void {
    this.#words *= 2;
    this.#rows = this.#rows.map((row) => {
      const wider = new Uint32Array(this.#words);
      wider.set(row);
      return wider;
    });
  }
}
