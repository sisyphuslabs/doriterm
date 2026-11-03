// The R3 engine: the record set, the views of its sub-sets with their caches, and the public viewOf. The rules are
// split by responsibility: structure.ts, standing.ts, testimony.ts, status.ts, membership.ts. No rule reads its own
// level's effectiveness, so view(S) is defined by induction on |S| and the canonical order: one view per set.

import type { Signed } from "../records/types.ts";
import { Dag, type Rec, setKey } from "./dag.ts";
import { type EngineView, membership } from "./membership.ts";
import { recordsOf } from "./rec-of.ts";
import { type Status, status } from "./status.ts";

/** Views keyed by their record set; shareable across calls, because a view depends only on its set. */
export type ViewCache = Map<string, EngineView>;

export class Engine {
  readonly dag: Dag;
  readonly #views: ViewCache;
  readonly #members = new Map<string, ReadonlySet<string>>();
  readonly #once = new Map<string, unknown>();
  readonly #perSet = new WeakMap<ReadonlySet<string>, Map<string, unknown>>();

  constructor(dag: Dag, views: ViewCache = new Map()) {
    this.dag = dag;
    this.#views = views;
  }

  /** A set-independent result (per record or record pair), computed once. */
  once<T>(key: string, compute: () => T): T {
    return memo(this.#once, key, compute);
  }

  /** A result that depends on the set S, keyed by the identity of S (view() keeps it for one evaluation). */
  cached<T>(S: ReadonlySet<string>, key: string, compute: () => T): T {
    let m = this.#perSet.get(S);
    if (m === undefined) {
      m = new Map();
      this.#perSet.set(S, m);
    }
    return memo(m, key, compute);
  }

  full(): EngineView {
    return this.view(this.dag.all());
  }

  /** view(past(x)); undefined for the found record. */
  before(id: string): EngineView | undefined {
    const past = this.dag.past(id);
    return past.size === 0 ? undefined : this.view(past);
  }

  /** M(x). */
  membersBefore(id: string): ReadonlySet<string> {
    const cached = this.#members.get(id);
    if (cached !== undefined) return cached;
    const out: ReadonlySet<string> = new Set(this.before(id)?.members ?? []);
    this.#members.set(id, out);
    return out;
  }

  view(S: ReadonlySet<string>): EngineView {
    const key = setKey(S);
    const cached = this.#views.get(key);
    if (cached !== undefined) return cached;
    const statuses = new Map<string, Status>();
    for (const id of this.dag.canonicalOrder(S)) statuses.set(id, status(this, S, id, statuses));
    const eff = new Set([...statuses].filter(([, st]) => st === "eff").map(([id]) => id));
    const view = membership(this.dag, S, eff);
    this.#views.set(key, view);
    return view;
  }
}

function memo<T>(store: Map<string, unknown>, key: string, compute: () => T): T {
  // A key is only ever stored by the computation that names it, so its value has that computation's type.
  if (store.has(key)) return store.get(key) as T;
  const value = compute();
  store.set(key, value);
  return value;
}

/** The R3 view of abstract records (one found, past-closed). */
export const viewOfRecords = (records: readonly Rec[], cache?: ViewCache): EngineView =>
  new Engine(new Dag(records), cache).full();

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
