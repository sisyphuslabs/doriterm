// The R3 engine: the record set, the views of its sub-sets with their caches, and the public viewOf. The rules are
// split by responsibility: structure.ts, standing.ts, testimony.ts, status.ts, membership.ts. No rule reads its own
// level's effectiveness, so view(S) is defined by induction on |S| and the canonical order: one view per set.
//
// Evaluation is incremental (M-14). Every set the rules ask about is past-closed, so a view is cached under the set's
// heads and view(past(x)) per record; per-record results depend only on the record's past and survive a merge (a
// grown set, evaluated through the same ViewCache). A view decides the statuses of the records membership() reads
// (every type but ack); only the full view, and a caller that asks for pastView(), decide the acks for `eff`. Those
// statuses depend on the set only through its context: its non-ack records, and the acks concurrent with one of them.
// Every R3 rule a status reaches asks the set about a revoke, a record on an admitter lineage, or a witness of a
// conflict between two concurrent non-ack records, and a witness that is an ack is concurrent with one of the two. So
// sets with one context share one evaluation, and only records concurrent with a revoke are ever re-evaluated: through
// a new context. What outlives a call lives in Shared, as plain data: an Engine and its Dag belong to one call.

import type { Signed } from "../records/types.ts";
import { bitsKey } from "./chain.ts";
import { Dag, headsKey, type PastSet, type Rec, type RecordSet } from "./dag.ts";
import { type EngineView, membership, type RuleView, withEff } from "./membership.ts";
import { recordsOf } from "./rec-of.ts";
import { type Evaluation, Shared } from "./shared.ts";
import { type Status, status } from "./status.ts";
import { valid } from "./structure.ts";

export class Engine {
  readonly dag: Dag;
  readonly #shared: Shared;

  constructor(dag: Dag, shared = new Shared(dag.history)) {
    if (shared.history !== dag.history) throw new Error("an engine shares state only with its own history");
    this.dag = dag;
    this.#shared = shared;
  }

  /** A result about records and their pasts (per record or record pair), computed once for every set. */
  once<T>(kind: string, key: string, compute: () => T): T {
    return this.#shared.once(kind, key, compute);
  }

  /** The records of a growing history list that pass `test`; see Shared.growing. */
  growing(key: string, source: readonly string[], test: (id: string) => boolean): readonly string[] {
    return this.#shared.growing(key, source, test);
  }

  /** A result that depends on the set S, keyed by the identity of S (a context or the set itself). */
  cached<T>(S: RecordSet, kind: string, key: string, compute: () => T): T {
    return this.#shared.cached(S, kind, key, compute);
  }

  /** The view of the whole set, with its effective records. */
  full(): EngineView {
    const S = this.dag.all();
    const { heads, context } = this.#keysOf(S);
    const decided = this.#shared.decide(heads, context(), () => this.#evaluateClosed(S));
    return withEff(decided.view, this.#eff(S, decided.statuses));
  }

  /** view(past(x)) as the rules read it; undefined for the found record. */
  before(id: string): RuleView | undefined {
    return this.#before(id);
  }

  /**
   * view(past(x)) with its effective records, for callers outside the rules; undefined for the found record. The
   * cache keeps no statuses for sub-views, so this evaluates past(x) again.
   */
  pastView(id: string): EngineView | undefined {
    if (this.#before(id) === undefined) return undefined;
    const past = this.#past(id);
    const { view, statuses } = this.#evaluate(past);
    return withEff(view, this.#eff(past, statuses));
  }

  /** M(x). */
  membersBefore(id: string): ReadonlySet<string> {
    return this.#shared.membersBefore(id, () => new Set(this.before(id)?.members ?? []));
  }

  /** The cache key of a past-closed set: its records that no other record of the set names as prev. */
  keyOf(S: PastSet): string {
    return headsKey(this.#headsOf(S));
  }

  /** The rule view of a past-closed set. S must not change after it is passed: its heads are cached by the object. */
  view(S: PastSet): RuleView {
    const { heads, context } = this.#keysOf(S);
    return this.#shared.view(heads, context, () => this.#evaluateClosed(S));
  }

  /** past(x) as a set that reads only the shared history, so a cached evaluation never holds this engine. */
  #past(id: string): RecordSet {
    void this.dag.index;
    const reach = this.dag.history.reach;
    return { has: (p) => reach.inPast(id, p) };
  }

  #before(id: string): RuleView | undefined {
    return this.#shared.before(id, () => {
      const prev = [...new Set(this.dag.rec(id).prev)];
      const heads = prev.filter((p) => !prev.some((q) => this.dag.inPast(q, p)));
      if (heads.length === 0) return undefined;
      const h = this.dag.history;
      const context = () => `${headsKey(h.relevantHeads(id))}|${bitsKey(h.witnessable(id))}`;
      return this.#shared.view(headsKey(heads), context, () => this.#evaluate(this.#past(id)));
    });
  }

  #headsOf(S: PastSet): readonly string[] {
    return this.#shared.headsOf(S, () => {
      const ids = this.dag.index.order.filter((id) => S.has(id));
      const named = new Set(ids.flatMap((id) => this.dag.rec(id).prev));
      return ids.filter((id) => !named.has(id));
    });
  }

  /** A set's cache key (its heads) and, on demand, its context. */
  #keysOf(S: PastSet): { readonly heads: string; readonly context: () => string } {
    const heads = this.#headsOf(S);
    const h = this.dag.history;
    // The context reads the history's summaries, so every record of this DAG is appended to it first.
    void this.dag.index;
    return {
      heads: headsKey(heads),
      context: () => `${headsKey(h.maximalRelevant(heads))}|${bitsKey(h.witnessableOf(heads))}`,
    };
  }

  #evaluateClosed(S: PastSet): Evaluation {
    // Ancestors first, so each record's own past is evaluated before a later record asks for it (no deep recursion).
    for (const id of this.dag.index.order) if (S.has(id)) valid(this, id);
    return this.#evaluate(S);
  }

  #evaluate(S: RecordSet): Evaluation {
    const statuses = new Map<string, Status>();
    for (const id of this.dag.index.relevant) if (S.has(id)) statuses.set(id, status(this, S, id, statuses));
    return { view: membership(this.dag, S, statuses), statuses };
  }

  /** The records of S that count, in canonical order; `decided` already holds every non-ack record of S. */
  #eff(S: RecordSet, decided: ReadonlyMap<string, Status>): ReadonlySet<string> {
    const out = new Set<string>();
    for (const id of this.dag.index.order) {
      if (!S.has(id)) continue;
      if ((decided.get(id) ?? status(this, S, id, decided)) === "eff") out.add(id);
    }
    return out;
  }
}

/**
 * One mesh's evaluation state across merges: the history of the records it has seen, and every result about them
 * that no later record can change. Views are keyed by their sets' heads, which is sound because the cache only reuses
 * its state for a set whose every known id is the same record object: a record hash fixes its past, and so does an
 * abstract record object. A set with another object under a known id (a re-parsed copy, or another DAG that reuses an
 * id) starts the state over. clear() drops all of it.
 */
export class ViewCache {
  #shared: Shared | undefined;

  /** An engine over `records` that reuses this cache's state when the records allow it. */
  engineFor(records: readonly Rec[]): Engine {
    const prior = this.#shared;
    if (prior !== undefined && prior.history.accepts(records))
      return new Engine(new Dag(records, prior.history), prior);
    const dag = new Dag(records);
    this.#shared = new Shared(dag.history);
    return new Engine(dag, this.#shared);
  }

  clear(): void {
    this.#shared = undefined;
  }
}

/** The R3 view of abstract records (one found, past-closed). */
export const viewOfRecords = (records: readonly Rec[], cache?: ViewCache): EngineView =>
  (cache?.engineFor(records) ?? new Engine(new Dag(records))).full();

export interface View {
  /** At most 12 members, in the canonical order of their governing admissions. */
  readonly members: ReadonlySet<string>;
  /** Admitted keys past the 12th member: not dialed, cannot sign. Disjoint from `members`. */
  readonly overCap: ReadonlySet<string>;
  readonly revoked: ReadonlySet<string>;
  /** signPub -> the member's current Noise key. */
  readonly noise: ReadonlyMap<string, string>;
  /** signPub -> the signPub that admitted it (the lineage), for every key with a governing admission, over-cap keys too. */
  readonly admitter: ReadonlyMap<string, string>;
  /** signPub -> the hash of its governing admission, for every key that has one, over-cap keys too. */
  readonly governing: ReadonlyMap<string, string>;
  /** signPub -> the member's mesh name after the fallback for taken names. */
  readonly name: ReadonlyMap<string, string>;
  /** Hashes of the records that count. */
  readonly eff: ReadonlySet<string>;
}

const EMPTY: View = {
  members: new Set(),
  overCap: new Set(),
  revoked: new Set(),
  noise: new Map(),
  admitter: new Map(),
  governing: new Map(),
  name: new Map(),
  eff: new Set(),
};

/**
 * The view of a stored record set (records that passed the door). Records whose past is incomplete are left out,
 * as the dangling pool would hold them; a set without exactly one found record has the empty view.
 */
export function viewOf(set: readonly Signed[], cache?: ViewCache): View {
  const records = recordsOf(set);
  if (records === undefined) return EMPTY;
  const v = viewOfRecords(records, cache);
  return {
    members: new Set(v.members),
    overCap: new Set(v.overCap),
    revoked: new Set(v.revoked),
    noise: v.noise,
    admitter: v.admitter,
    governing: v.governing,
    name: v.name,
    eff: v.eff,
  };
}
