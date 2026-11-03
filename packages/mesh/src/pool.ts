// The revoke-time witness pool (design section 6.1): computed from the local set with no clock, before a revoke is
// written. For subject X with last own record L (its admission if it never wrote), the pool is
// members(view(past(L))) minus X, the revoker, the revoker's admitters after L and the batch, intersected with the
// current members. An empty pool means a backdated attack by X could not be decided.

import type { Signed } from "./records/types.ts";
import { Dag, isAdmission, type Rec } from "./view/dag.ts";
import { Engine, type ViewCache } from "./view/engine.ts";
import { recordsOf } from "./view/rec-of.ts";
import { lineage } from "./view/structure.ts";

/** X's last own record, or its admission if it never wrote: the position a revoke of X is judged from. */
function positionOf(records: readonly Rec[], X: string): Rec | undefined {
  const own = records.filter((r) => r.by === X && r.type !== "found").toSorted((a, b) => b.n - a.n)[0];
  return own ?? records.find((r) => isAdmission(r) && r.subject === X);
}

export function witnessPoolOfRecords(
  records: readonly Rec[],
  revoker: string,
  subjects: readonly string[],
  cache?: ViewCache,
): ReadonlyMap<string, readonly string[]> {
  const e = new Engine(new Dag(records), cache);
  const now = e.full();
  const out = new Map<string, readonly string[]>();
  for (const X of subjects) {
    const L = positionOf(records, X);
    if (L === undefined) continue;
    const C = new Set([L.id, ...e.dag.past(L.id)]);
    const minted = new Set((lineage(e, revoker, now, C) ?? []).map((g) => e.dag.rec(g).by));
    const present = e.dag.past(L.id).size === 0 ? [] : e.view(e.dag.past(L.id)).members;
    const excluded = (k: string): boolean => k === X || k === revoker || minted.has(k) || subjects.includes(k);
    out.set(
      X,
      present.filter((k) => !excluded(k) && now.members.includes(k)),
    );
  }
  return out;
}

/**
 * Per subject, the members that could witness a backdating conflict against a revoke `revoker` writes now. `cache`
 * lets several calls on one set share their views.
 */
export function witnessPool(
  set: readonly Signed[],
  revoker: string,
  subjects: readonly string[],
  cache?: ViewCache,
): ReadonlyMap<string, readonly string[]> {
  const records = recordsOf(set);
  return records === undefined ? new Map() : witnessPoolOfRecords(records, revoker, subjects, cache);
}

/** The members at X's position other than X: whom a backdated record of X's key could eject (design 6.1). */
export function presentAtOfRecords(records: readonly Rec[], X: string, cache?: ViewCache): readonly string[] {
  const L = positionOf(records, X);
  if (L === undefined) return [];
  const e = new Engine(new Dag(records), cache);
  const past = e.dag.past(L.id);
  return past.size === 0 ? [] : e.view(past).members.filter((k) => k !== X);
}

export function presentAt(set: readonly Signed[], X: string, cache?: ViewCache): readonly string[] {
  const records = recordsOf(set);
  return records === undefined ? [] : presentAtOfRecords(records, X, cache);
}
