// Design 3.7, the fail-closed limit: when no voter can decide a conflict that a revoked key X started, X's
// admits, names and rekeys are tie-voided and its revokes stand. The members that removed are what `mesh status`
// reports as "removed by an undecidable backdated revoke of X" (section 8.6).

import type { Signed } from "./records/types.ts";
import { Dag, type Rec, subjectsOf } from "./view/dag.ts";
import { Engine, type ViewCache } from "./view/engine.ts";
import { recordsOf } from "./view/rec-of.ts";
import { accusers } from "./view/standing.ts";
import { supportAt, verdict, voters } from "./view/testimony.ts";

export interface FailClosed {
  /** The revoked key whose undecidable conflict removed them. */
  readonly revokedKey: string;
  /** Keys the honest outcome keeps that are now not members. */
  readonly removed: readonly string[];
}

export function failClosedOfRecords(records: readonly Rec[], cache?: ViewCache): readonly FailClosed[] {
  const e = cache?.engineFor(records) ?? new Engine(new Dag(records));
  const now = e.full();
  const S = e.dag.all();
  const current = new Set(now.members);
  const revoked = new Set(now.revoked);
  /** Per revoked key, the keys its undecided conflicts removed. */
  const removed = new Map<string, Set<string>>();
  const by = (key: string): Set<string> => {
    const set = removed.get(key) ?? new Set<string>();
    removed.set(key, set);
    return set;
  };
  const conflicts = [...e.dag.index.relevant]
    .filter((id) => S.has(id))
    .flatMap((id) => accusers(e, S, id).map((v) => ({ v, x: id, verdict: verdict(e, S, v, id, 1, accusers) })));
  // A revoked key's revoke that stood a 0:0 conflict with a revoke of that key: the keys it names are removed.
  for (const { v, x, verdict: vd } of conflicts) {
    const r = e.dag.rec(x);
    if (vd === "stands" && r.type === "revoke" && revoked.has(r.by) && now.eff.has(x) && undecided(e, S, v, x)) {
      for (const subject of subjectsOf(r)) by(r.by).add(subject);
    }
  }
  // Admissions by a key a revoked key removed, tie-voided (0:0) by that revoked key's revoke: their subjects go too.
  for (let grew = true; grew;) {
    grew = false;
    for (const { v, x, verdict: vd } of conflicts) {
      const r = e.dag.rec(x);
      const accuser = e.dag.rec(v).by;
      if (vd !== "tie" || r.type !== "admit" || !revoked.has(accuser) || !by(accuser).has(r.by)) continue;
      for (const subject of subjectsOf(r)) {
        if (!by(accuser).has(subject)) {
          by(accuser).add(subject);
          grew = true;
        }
      }
    }
  }
  return [...removed]
    .map(([revokedKey, keys]) => ({ revokedKey, removed: [...keys].filter((key) => !current.has(key)) }))
    .filter((fact) => fact.removed.length > 0);
}

/** Neither side of the conflict between revoke `v` and record `x` has any testimony: 0:0 at level 1. */
function undecided(e: Engine, S: ReturnType<Dag["all"]>, v: string, x: string): boolean {
  const pool = voters(e, v, x, 1);
  return supportAt(e, S, x, v, pool, 1, accusers) === 0 && supportAt(e, S, v, x, pool, 1, accusers) === 0;
}

/** The fail-closed removals of a stored record set (records that passed the door). */
export function failClosedOf(set: readonly Signed[], cache?: ViewCache): readonly FailClosed[] {
  const records = recordsOf(set);
  return records === undefined ? [] : failClosedOfRecords(records, cache);
}
