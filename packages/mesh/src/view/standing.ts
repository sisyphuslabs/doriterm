// R3 "Level 0" accusers and "Standing": which revokes may accuse. Level 0 lets every structurally valid concurrent
// revoke accuse; level 1 keeps only the accusers whose provenance survives level 0. Reads level 0 only.

import type { RecordSet } from "./dag.ts";
import type { Engine } from "./engine.ts";
import { common, lineage, valid } from "./structure.ts";
import { verdict } from "./testimony.ts";

const NONE: readonly string[] = [];

/** The revokes anywhere in the history that name x.by and are concurrent with x; accusers0 keeps those in S. */
const concurrentRevokes = (e: Engine, id: string): readonly string[] =>
  e.growing(`cv:${id}`, e.dag.history.revoking(e.dag.rec(id).by), (vid) => e.dag.conc(vid, id));

/** accusers0(x) = { v ∈ S : v.type == revoke, x.by ∈ v.subjects, v ∥ x, valid(v) }. */
export function accusers0(e: Engine, S: RecordSet, id: string): readonly string[] {
  const near = concurrentRevokes(e, id);
  if (!near.some((vid) => S.has(vid))) return NONE;
  return e.cached(S, "a0", id, () => near.filter((vid) => S.has(vid) && valid(e, vid)));
}

export const defeats0 = (e: Engine, S: RecordSet, v: string, x: string): boolean =>
  verdict(e, S, v, x, 0, accusers0) === "defeated";

/** clean0(r, C) = ∀ g ∈ lineage(r.by, view(past(r)), C): ¬∃ u ∈ accusers0(g): defeats0(u, g). */
export function clean0(e: Engine, S: RecordSet, r: string, C: ReadonlySet<string>): boolean {
  return e.cached(S, "c0", `${r}:${e.keyOf(C)}`, () => {
    const chain = lineage(e, e.dag.rec(r).by, e.before(r), C);
    return chain !== undefined && chain.every((g) => !accusers0(e, S, g).some((u) => defeats0(e, S, u, g)));
  });
}

/** standing(v, x) = clean0(v, C(v, x)) and ¬∃ u ∈ accusers0(v): clean0(u, C(u, v)) and defeats0(u, v). */
export function standing(e: Engine, S: RecordSet, v: string, x: string): boolean {
  return e.cached(S, "st", `${v}:${x}`, () => {
    if (!clean0(e, S, v, common(e, v, x))) return false;
    return !accusers0(e, S, v).some((u) => clean0(e, S, u, common(e, u, v)) && defeats0(e, S, u, v));
  });
}

/** accusers(x) = { v ∈ accusers0(x) : standing(v, x) }. */
export function accusers(e: Engine, S: RecordSet, id: string): readonly string[] {
  const level0 = accusers0(e, S, id);
  if (level0.length === 0) return NONE;
  return e.cached(S, "a1", id, () => level0.filter((v) => standing(e, S, v, id)));
}
