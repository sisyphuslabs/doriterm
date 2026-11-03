// The R3 engine: the record set, the views of its sub-sets with their caches, and the public viewOf. The rules are
// split by responsibility: structure.ts, standing.ts, testimony.ts, status.ts, membership.ts. No rule reads its own
// level's effectiveness, so view(S) is defined by induction on |S| and the canonical order: one view per set.
//
// Evaluation is incremental (M-14). Every set the rules ask about is past-closed, so a view is cached under the set's
// heads and view(past(x)) per record; per-record results depend only on the record's past and survive a merge (a
// grown set, evaluated through the same ViewCache). A view decides the statuses of the records membership() reads
// (every type but ack) and leaves the rest of `eff` to the first read. Those statuses depend on the set only through
// its context: its non-ack records, and the acks concurrent with one of them. Every R3 rule a status reaches asks the
// set about a revoke, a record on an admitter lineage, or a witness of a conflict between two concurrent non-ack
// records, and a witness that is an ack is concurrent with one of the two. So sets with one context share one
// evaluation, and only records concurrent with a revoke are ever re-evaluated: through a new context.

import type { Signed } from "../records/types.ts";
import { bitsKey } from "./chain.ts";
import { Dag, headsKey, type Rec, type RecordSet } from "./dag.ts";
import { type EngineView, membership, withEff } from "./membership.ts";
import { recordsOf } from "./rec-of.ts";
import { Shared } from "./shared.ts";
import { type Status, status } from "./status.ts";
import { valid } from "./structure.ts";

/** Views keyed by their record set; shareable across calls, because a view depends only on its set. */
export type ViewCache = Map<string, EngineView>;

export class Engine {
  readonly dag: Dag;
  readonly #views: ViewCache;
  readonly #shared: Shared;

  constructor(dag: Dag, views: ViewCache = new Map(), shared = new Shared(dag.history)) {
    if (shared.history !== dag.history) throw new Error("an engine shares state only with its own history");
    this.dag = dag;
    this.#views = views;
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

  static sharedOf(e: Engine): Shared {
    return e.#shared;
  }

  full(): EngineView {
    return this.view(this.dag.all());
  }

  /** view(past(x)); undefined for the found record. */
  before(id: string): EngineView | undefined {
    return this.#shared.before(id, () => {
      const prev = [...new Set(this.dag.rec(id).prev)];
      const heads = prev.filter((p) => !prev.some((q) => this.dag.inPast(q, p)));
      if (heads.length === 0) return undefined;
      const h = this.dag.history;
      const context = `${headsKey(h.relevantHeads(id))}|${bitsKey(h.witnessable(id))}`;
      return this.#evaluate({ has: (p) => this.dag.inPast(id, p) }, headsKey(heads), context);
    });
  }

  /** M(x). */
  membersBefore(id: string): ReadonlySet<string> {
    return this.#shared.membersBefore(id, () => new Set(this.before(id)?.members ?? []));
  }

  /** The cache key of a past-closed set: its records that no other record of the set names as prev. */
  keyOf(S: ReadonlySet<string>): string {
    return headsKey(this.#headsOf(S));
  }

  #headsOf(S: ReadonlySet<string>): readonly string[] {
    return this.#shared.headsOf(S, () => {
      const named = new Set([...S].flatMap((id) => this.dag.rec(id).prev));
      return [...S].filter((id) => !named.has(id));
    });
  }

  view(S: ReadonlySet<string>): EngineView {
    const key = this.keyOf(S);
    const cached = this.#views.get(key);
    if (cached !== undefined) return cached;
    // Ancestors first, so each record's own past is evaluated before a later record asks for it (no deep recursion).
    for (const id of this.dag.index.order) if (S.has(id)) valid(this, id);
    const heads = this.#headsOf(S);
    const h = this.dag.history;
    return this.#evaluate(S, key, `${headsKey(h.maximalRelevant(heads))}|${bitsKey(h.witnessableOf(heads))}`);
  }

  #evaluate(S: RecordSet, key: string, context: string): EngineView {
    const cached = this.#views.get(key);
    if (cached !== undefined) return cached;
    const { set, core } = this.#shared.core(S, context, (ctx) => {
      const statuses = new Map<string, Status>();
      for (const id of this.dag.index.relevant) if (ctx.has(id)) statuses.set(id, status(this, ctx, id, statuses));
      return { view: membership(this.dag, ctx, statuses, () => this.#eff(ctx, statuses)), statuses };
    });
    const view = set === S ? core.view : withEff(core.view, () => this.#eff(S, core.statuses));
    this.#views.set(key, view);
    return view;
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

/** Per cache, the engine of the last call: its per-record results carry over to the next set evaluated through it. */
const engines = new WeakMap<ViewCache, Engine>();

/** The R3 view of abstract records (one found, past-closed). */
export function viewOfRecords(records: readonly Rec[], cache?: ViewCache): EngineView {
  const prior = cache === undefined ? undefined : engines.get(cache);
  const shared = prior === undefined ? undefined : Engine.sharedOf(prior);
  const dag = shared?.history.accepts(records) === true ? new Dag(records, shared.history) : new Dag(records);
  const engine = new Engine(dag, cache, shared?.history === dag.history ? shared : undefined);
  if (cache !== undefined) engines.set(cache, engine);
  return engine.full();
}

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
