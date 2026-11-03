// R3 "Level 0" accusers and "Standing": which revokes may accuse. Level 0 lets every structurally valid concurrent
// revoke accuse; level 1 keeps only the accusers whose provenance survives level 0. Reads level 0 only.

import { setKey, subjectsOf } from "./dag.ts";
import type { Engine } from "./engine.ts";
import { common, lineage, valid } from "./structure.ts";
import { verdict } from "./testimony.ts";

/** accusers0(x) = { v ∈ S : v.type == revoke, x.by ∈ v.subjects, v ∥ x, valid(v) }. */
export function accusers0(e: Engine, S: ReadonlySet<string>, id: string): readonly string[] {
  return e.cached(S, `a0:${id}`, () => {
    const by = e.dag.rec(id).by;
    return [...S].filter((vid) => {
      const v = e.dag.rec(vid);
      return v.type === "revoke" && subjectsOf(v).includes(by) && e.dag.conc(vid, id) && valid(e, vid);
    });
  });
}

export const defeats0 = (e: Engine, S: ReadonlySet<string>, v: string, x: string): boolean =>
  verdict(e, S, v, x, 0, accusers0) === "defeated";

/** clean0(r, C) = ∀ g ∈ lineage(r.by, view(past(r)), C): ¬∃ u ∈ accusers0(g): defeats0(u, g). */
export function clean0(e: Engine, S: ReadonlySet<string>, r: string, C: ReadonlySet<string>): boolean {
  return e.cached(S, `c0:${r}:${setKey(C)}`, () =>
    lineage(e, e.dag.rec(r).by, e.before(r), C).every((g) => !accusers0(e, S, g).some((u) => defeats0(e, S, u, g))),
  );
}

/** standing(v, x) = clean0(v, C(v, x)) and ¬∃ u ∈ accusers0(v): clean0(u, C(u, v)) and defeats0(u, v). */
export function standing(e: Engine, S: ReadonlySet<string>, v: string, x: string): boolean {
  return e.cached(S, `st:${v}:${x}`, () => {
    if (!clean0(e, S, v, common(e, v, x))) return false;
    return !accusers0(e, S, v).some((u) => clean0(e, S, u, common(e, u, v)) && defeats0(e, S, u, v));
  });
}

/** accusers(x) = { v ∈ accusers0(x) : standing(v, x) }. */
export function accusers(e: Engine, S: ReadonlySet<string>, id: string): readonly string[] {
  return e.cached(S, `a1:${id}`, () => accusers0(e, S, id).filter((v) => standing(e, S, v, id)));
}
