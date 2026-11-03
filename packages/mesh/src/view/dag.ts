// The record DAG the view is computed over. `id` is the record hash; every tie the contract breaks on hashes is
// broken on `id`, by code unit (the same as bytewise for base64url).

import type { RecordType } from "../records/types.ts";
import { History } from "./chain.ts";

/** The subject's self-signed member card, as the view reads it: `by` is the card's subject (its signPub). */
export interface Card {
  readonly by: string;
  readonly hostId: string;
  readonly inviter: string;
  readonly noise: string;
  readonly name: string;
  readonly nonce: string;
}

export interface Rec {
  readonly id: string;
  readonly type: RecordType;
  readonly by: string;
  readonly n: number;
  readonly prev: readonly string[];
  /** found, admit, name, rekey: the key the record is about. */
  readonly subject?: string;
  /** revoke: the keys it revokes. */
  readonly subjects?: readonly string[];
  /** found, admit, rekey. */
  readonly card?: Card;
  /** name: the new mesh name. */
  readonly name?: string;
}

export const subjectsOf = (r: Rec): readonly string[] => r.subjects ?? (r.subject === undefined ? [] : [r.subject]);
export const isAdmission = (r: Rec): boolean => r.type === "found" || r.type === "admit";
export const revokesKey = (v: Rec, k: string): boolean => v.type === "revoke" && subjectsOf(v).includes(k);

/** A past-closed set of record ids as the rules read it: membership only. */
export interface RecordSet {
  has(id: string): boolean;
}

/** The cache key of a past-closed set: its maximal records, sorted. A past-closed set is its heads and their past. */
export const headsKey = (heads: Iterable<string>): string => [...heads].toSorted().join("\u0000");

export type DagProblem = "duplicate id" | "found count" | "dangling prev" | "unknown id";

export class DagError extends Error {
  readonly problem: DagProblem;

  constructor(problem: DagProblem, detail: string) {
    super(`${problem}: ${detail}`);
    this.problem = problem;
  }
}

export class Dag {
  readonly byId: ReadonlyMap<string, Rec>;
  readonly found: Rec;
  /** Append-only summaries of every record's past, shareable with the DAG of a grown or smaller set. */
  readonly history: History;
  readonly #past = new Map<string, ReadonlySet<string>>();
  #index: Index | undefined;

  constructor(records: readonly Rec[], history = new History()) {
    this.byId = new Map(records.map((r) => [r.id, r]));
    if (this.byId.size !== records.length) throw new DagError("duplicate id", `${records.length} records`);
    const founds = records.filter((r) => r.type === "found");
    const found = founds[0];
    if (founds.length !== 1 || found === undefined) throw new DagError("found count", `${founds.length}`);
    this.found = found;
    for (const r of records)
      for (const p of r.prev) if (!this.byId.has(p)) throw new DagError("dangling prev", `${r.id} -> ${p}`);
    this.history = history;
  }

  rec(id: string): Rec {
    const r = this.byId.get(id);
    if (r === undefined) throw new DagError("unknown id", id);
    return r;
  }

  all(): ReadonlySet<string> {
    return new Set(this.byId.keys());
  }

  /** Everything reachable through prev, excluding the record itself. */
  past(id: string): ReadonlySet<string> {
    const cached = this.#past.get(id);
    if (cached !== undefined) return cached;
    const out = new Set<string>();
    const stack = [...this.rec(id).prev];
    for (let p = stack.pop(); p !== undefined; p = stack.pop()) {
      if (out.has(p)) continue;
      out.add(p);
      stack.push(...this.rec(p).prev);
    }
    this.#past.set(id, out);
    return out;
  }

  conc(a: string, b: string): boolean {
    return a !== b && !this.inPast(a, b) && !this.inPast(b, a);
  }

  /**
   * The canonical order of the whole DAG with its indexes, built on first use. Restricted to any past-closed subset,
   * it is that subset's own canonical order: a record outside the subset never holds back one inside it, so the
   * subset's ready records evolve exactly as they would alone.
   */
  get index(): Index {
    if (this.#index !== undefined) return this.#index;
    const order = kahn(new Map([...this.byId].map(([id, r]) => [id, r.prev])));
    if (order.length !== this.byId.size) throw new DagError("dangling prev", "no ready record");
    for (const id of order) {
      if (this.history.has(id)) continue;
      const r = this.rec(id);
      this.history.append(r, isRelevant(r), r.type === "revoke" ? subjectsOf(r) : []);
    }
    this.#index = indexOf(this, order);
    return this.#index;
  }

  /** id ∈ past(of). */
  inPast(of: string, id: string): boolean {
    if (this.#index === undefined) void this.index;
    return this.history.reach.inPast(of, id);
  }

  /** The canonical order of a past-closed set. */
  canonicalOrder(S: ReadonlySet<string>): readonly string[] {
    if ([...S].every((id) => this.byId.get(id)?.prev.every((p) => S.has(p)) === true))
      return this.index.order.filter((id) => S.has(id));
    const order = kahn(new Map([...S].map((id) => [id, this.rec(id).prev.filter((p) => S.has(p))])));
    if (order.length !== S.size) throw new DagError("dangling prev", "no ready record");
    return order;
  }
}

/**
 * Kahn's topological order of the ids of `parents` (each id's parents inside the set), smallest id first among the
 * ready ones: the canonical order of the contract, for abstract and for signed records alike. A cycle leaves its
 * records out, so a caller that needs every id compares the length.
 */
export function kahn(parents: ReadonlyMap<string, readonly string[]>): readonly string[] {
  const waiting = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const [id, prev] of parents) {
    waiting.set(id, prev.length);
    for (const p of prev) {
      const list = children.get(p);
      if (list === undefined) children.set(p, [id]);
      else list.push(id);
    }
  }
  const ready = [...waiting].filter(([, count]) => count === 0).map(([id]) => id);
  ready.sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const next = ready.shift();
    if (next === undefined) break;
    order.push(next);
    for (const child of children.get(next) ?? []) {
      const left = (waiting.get(child) ?? 1) - 1;
      waiting.set(child, left);
      if (left === 0) ready.splice(sortedIndex(ready, child), 0, child);
    }
  }
  return order;
}

function sortedIndex(sorted: readonly string[], id: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] ?? "") < id) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Indexes over the whole DAG, every list in canonical order. */
export interface Index {
  readonly order: readonly string[];
  /** id -> its place in the canonical order. */
  readonly position: ReadonlyMap<string, number>;
  /** Every record except acks: the records membership() reads. */
  readonly relevant: readonly string[];
  readonly admissions: readonly string[];
  readonly bySigner: ReadonlyMap<string, readonly string[]>;
}

export const isRelevant = (r: Rec): boolean => r.type !== "ack";

function indexOf(dag: Dag, order: readonly string[]): Index {
  const bySigner = new Map<string, string[]>();
  for (const id of order) {
    const by = dag.rec(id).by;
    const list = bySigner.get(by);
    if (list === undefined) bySigner.set(by, [id]);
    else list.push(id);
  }
  return {
    order,
    position: new Map(order.map((id, i) => [id, i])),
    relevant: order.filter((id) => isRelevant(dag.rec(id))),
    admissions: order.filter((id) => isAdmission(dag.rec(id))),
    bySigner,
  };
}
