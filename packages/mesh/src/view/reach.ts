// The reachability of a DAG as one bitset per record. Bitsets are indexed by arrival, so a grown record set extends
// them instead of rebuilding them.

export type Bits = Uint32Array;

export const bitAt = (bits: Bits, i: number): boolean => ((bits[i >>> 5] ?? 0) & (1 << (i & 31))) !== 0;

const setBit = (bits: Bits, i: number): void => {
  bits[i >>> 5] = (bits[i >>> 5] ?? 0) | (1 << (i & 31));
};

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

  /** Adds a record whose prev records were all appended before it. */
  append(id: string, prev: readonly string[]): void {
    const i = this.#rows.length;
    if (i >= this.#words * 32) this.#grow();
    const row = new Uint32Array(this.#words);
    for (const p of prev) {
      const at = this.#arrival.get(p);
      const parent = at === undefined ? undefined : this.#rows[at];
      if (at === undefined || parent === undefined) continue;
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
