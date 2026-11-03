// The record DAG the view is computed over. `id` is the record hash; every tie the contract breaks on hashes is
// broken on `id`, by code unit (the same as bytewise for base64url).

import type { RecordType } from "../records/types.ts";

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
export const setKey = (S: ReadonlySet<string>): string => [...S].toSorted().join("\u0000");

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
  readonly #past = new Map<string, ReadonlySet<string>>();

  constructor(records: readonly Rec[]) {
    this.byId = new Map(records.map((r) => [r.id, r]));
    if (this.byId.size !== records.length) throw new DagError("duplicate id", `${records.length} records`);
    const founds = records.filter((r) => r.type === "found");
    const found = founds[0];
    if (founds.length !== 1 || found === undefined) throw new DagError("found count", `${founds.length}`);
    this.found = found;
    for (const r of records)
      for (const p of r.prev) if (!this.byId.has(p)) throw new DagError("dangling prev", `${r.id} -> ${p}`);
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
    return a !== b && !this.past(a).has(b) && !this.past(b).has(a);
  }

  /** Kahn's algorithm over a past-closed set, smallest id first among the ready records. */
  canonicalOrder(S: ReadonlySet<string>): readonly string[] {
    const remaining = new Set(S);
    const out: string[] = [];
    while (remaining.size > 0) {
      const ready = [...remaining].filter((id) => this.rec(id).prev.every((p) => !remaining.has(p))).toSorted();
      const next = ready[0];
      if (next === undefined) throw new DagError("dangling prev", "no ready record");
      out.push(next);
      remaining.delete(next);
    }
    return out;
  }
}
