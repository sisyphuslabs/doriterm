// Per-record summaries of a record's past, kept append-only so a grown record set extends them: the top of each
// signer's own chain, the maximal records membership() reads (every type but ack), and the acks that can testify on
// a conflict between such records.

import { type Bits, Reach } from "./reach.ts";

/** The highest counter a signer used in a past, and every record of that signer with it (more than one: a fork). */
export interface Top {
  readonly n: number;
  readonly at: readonly string[];
}

export interface ChainRec {
  readonly id: string;
  readonly by: string;
  readonly n: number;
  readonly prev: readonly string[];
}

const higher = (a: Top | undefined, b: Top | undefined): Top | undefined => {
  if (a === undefined || (b !== undefined && b.n > a.n)) return b;
  if (b === undefined || b.n < a.n || b === a) return a;
  return { n: a.n, at: [...new Set([...a.at, ...b.at])] };
};

const nonZero = (bits: Bits): boolean => bits.some((w) => w !== 0);

function listOf(lists: Map<string, string[]>, key: string): string[] {
  let list = lists.get(key);
  if (list === undefined) {
    list = [];
    lists.set(key, list);
  }
  return list;
}

export class History {
  readonly reach = new Reach();
  readonly #source = new Map<string, ChainRec>();
  readonly #bySigner = new Map<string, string[]>();
  readonly #revoking = new Map<string, string[]>();
  readonly #tops = new Map<string, ReadonlyMap<string, Top>>();
  readonly #ownTop = new Map<string, Top | undefined>();
  readonly #closedRelevant = new Map<string, readonly string[]>();
  readonly #relevantHeads = new Map<string, readonly string[]>();
  readonly #witnessable = new Map<string, Bits>();
  #relevant: Bits = new Uint32Array(0);
  #acks: Bits = new Uint32Array(0);

  has(id: string): boolean {
    return this.reach.arrival(id) !== undefined;
  }

  /** Every record of the signer, in arrival order; the array grows as records are appended. */
  signedBy(by: string): readonly string[] {
    return listOf(this.#bySigner, by);
  }

  /** Every revoke that names the key, in arrival order; the array grows as records are appended. */
  revoking(key: string): readonly string[] {
    return listOf(this.#revoking, key);
  }

  /** Whether a DAG of `records` may use this history: every record it already holds is the same object. */
  accepts(records: readonly ChainRec[]): boolean {
    return records.every((r) => (this.#source.get(r.id) ?? r) === r);
  }

  /** The top of x.by's own records in past(x), or undefined when there are none. */
  ownTop(id: string): Top | undefined {
    return this.#ownTop.get(id);
  }

  /** The maximal non-ack records of past(x), sorted: they determine past(x)'s non-ack records. */
  relevantHeads(id: string): readonly string[] {
    return this.#relevantHeads.get(id) ?? [];
  }

  /** The acks of past(x) concurrent with some non-ack record of past(x). */
  witnessable(id: string): Bits {
    return this.#witnessable.get(id) ?? new Uint32Array(0);
  }

  /** Adds a record whose prev records were all appended before it. */
  append(r: ChainRec, relevant: boolean, revokes: readonly string[]): void {
    const prev = [...new Set(r.prev)];
    this.#source.set(r.id, r);
    listOf(this.#bySigner, r.by).push(r.id);
    for (const k of new Set(revokes)) listOf(this.#revoking, k).push(r.id);
    this.reach.append(r.id, prev);
    const at = this.reach.arrival(r.id) ?? 0;
    this.#relevant = this.#mark(this.#relevant, at, relevant);
    this.#acks = this.#mark(this.#acks, at, !relevant);
    const merged = new Map<string, Top>();
    for (const p of prev)
      for (const [by, top] of this.#tops.get(p) ?? []) {
        const best = higher(merged.get(by), top);
        if (best !== undefined) merged.set(by, best);
      }
    this.#ownTop.set(r.id, merged.get(r.by));
    const self = higher(merged.get(r.by), { n: r.n, at: [r.id] });
    if (self !== undefined) merged.set(r.by, self);
    this.#tops.set(r.id, merged);
    const heads = this.maximalRelevant(prev);
    this.#relevantHeads.set(r.id, heads);
    this.#closedRelevant.set(r.id, relevant ? [r.id] : heads);
    this.#witnessable.set(r.id, this.witnessableOf(prev));
  }

  /** The maximal non-ack records of the union of {p} ∪ past(p) over `heads`, sorted. */
  maximalRelevant(heads: readonly string[]): readonly string[] {
    const candidates = [...new Set(heads.flatMap((p) => this.#closedRelevant.get(p) ?? []))];
    return candidates.filter((c) => !candidates.some((d) => d !== c && this.reach.inPast(d, c))).toSorted();
  }

  /**
   * The acks of the union U of {p} ∪ past(p) over `heads` that are concurrent with some non-ack record of U. Each head
   * contributes its own; across two heads, an ack only one of them has is concurrent with every non-ack record only
   * the other has, so it joins exactly when the other side has one.
   */
  witnessableOf(heads: readonly string[]): Bits {
    const words = this.reach.words;
    const out = new Uint32Array(words);
    const closed = heads.map((p) => this.reach.closed(p));
    for (const p of heads) this.#witnessable.get(p)?.forEach((w, i) => (out[i] = (out[i] ?? 0) | w));
    for (const [i, own] of closed.entries())
      for (const [j, other] of closed.entries()) {
        if (i === j) continue;
        const theirs = other.map((w, k) => w & ~(own[k] ?? 0) & (this.#relevant[k] ?? 0));
        if (!nonZero(theirs)) continue;
        for (let k = 0; k < words; k++)
          out[k] = (out[k] ?? 0) | ((own[k] ?? 0) & ~(other[k] ?? 0) & (this.#acks[k] ?? 0));
      }
    return out;
  }

  #mark(bits: Bits, at: number, on: boolean): Bits {
    const out = bits.length * 32 > at ? bits : Uint32Array.from({ length: this.reach.words }, (_, k) => bits[k] ?? 0);
    if (on) out[at >>> 5] = (out[at >>> 5] ?? 0) | (1 << (at & 31));
    return out;
  }
}

/** A bitset's exact key: its non-zero words. */
export const bitsKey = (bits: Bits): string =>
  [...bits].flatMap((w, k) => (w === 0 ? [] : [`${k}.${w >>> 0}`])).join(",");
