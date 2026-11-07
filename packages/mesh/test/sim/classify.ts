// How an attack changed the view (design section 3.7): a takeover or a decidable removal (both failures), or one of
// the disclosed categories: fail closed at an undecidable fork, an honest tie-voided admission revived, residual 2
// at the fork, residual 3 (a sole-witness race). Takeover and decidable removal are classified FIRST (M-r3.1), so
// a history that is also a sole-witness race can still fail the zero-takeover assertion.

import { Dag, type Rec } from "../../src/view/dag.ts";
import { Engine } from "../../src/view/engine.ts";
import type { EngineView } from "../../src/view/membership.ts";
import { accusers, accusers0 } from "../../src/view/standing.ts";
import { supportAt, verdict, voters } from "../../src/view/testimony.ts";
import type { World } from "./world.ts";

export type ChangeKind =
  | "none"
  | "takeover"
  | "removal-decidable"
  | "colluder-majority"
  | "sole-witness"
  | "removal-undecidable"
  | "revived-undecidable";

export const sig = (v: EngineView): string =>
  JSON.stringify([v.members.toSorted(), v.revoked, [...v.noise].toSorted(), [...v.name].toSorted()]);

/** Residual 3: a race only attacker keys could witness (0:0, every voter in the batch), decided by their testimony. */
function soleWitnessRace(w: World, before: readonly Rec[], batch: readonly string[]): boolean {
  const all = new Engine(new Dag(w.records));
  const old = new Engine(new Dag(before));
  const S = all.dag.all();
  const S0 = old.dag.all();
  if (![...S0].some((id) => old.full().eff.has(id) !== all.full().eff.has(id))) return false;
  return [...S0].some((x) =>
    accusers(old, S0, x).some((v) => {
      const pool = voters(old, v, x, 1);
      const silent =
        supportAt(old, S0, x, v, pool, 1, accusers) === 0 && supportAt(old, S0, v, x, pool, 1, accusers) === 0;
      const flipped =
        (verdict(all, S, v, x, 1, accusers) === "defeated") !== (verdict(old, S0, v, x, 1, accusers) === "defeated");
      return pool.length > 0 && pool.every((k) => batch.includes(k)) && silent && flipped;
    }),
  );
}

/** Every conflict between an acked accuser and an effective attacker record had a silent or empty voter pool. */
function undecidableFork(w: World, acked: readonly Rec[], made: readonly Rec[]): boolean {
  const e = new Engine(new Dag(w.records));
  const S = e.dag.all();
  const ackedIds = new Set(acked.map((r) => r.id));
  const after = e.full();
  for (const x of made.filter((m) => after.eff.has(m.id))) {
    for (const a of accusers(e, S, x.id)) {
      if (!ackedIds.has(a)) continue;
      const pool = voters(e, a, x.id, 1);
      if (pool.some((p) => acked.some((r) => r.by === p && e.dag.past(r.id).has(a)))) return false;
    }
  }
  return true;
}

/** Residual 2 at the fork: an honest accuser's level-0 pool holds at least as many batch keys as honest keys. */
export function colluderMajority(
  w: World,
  acked: readonly Rec[],
  batch: readonly string[],
  made: readonly Rec[],
): boolean {
  const e = new Engine(new Dag(w.records));
  const S = e.dag.all();
  const after = e.full();
  for (const x of made.filter((m) => after.eff.has(m.id))) {
    for (const a of accusers0(e, S, x.id)) {
      if (!acked.some((r) => r.id === a)) continue;
      const pool = voters(e, a, x.id, 0);
      const colluders = pool.filter((p) => batch.includes(p)).length;
      if (colluders > 0 && colluders >= pool.length - colluders) return true;
    }
  }
  return false;
}

export function classifyChange(
  w: World,
  acked: readonly Rec[],
  batch: readonly string[],
  baseView: EngineView,
  made: readonly Rec[],
): ChangeKind {
  const after = w.full();
  if (sig(after) === sig(baseView)) return "none";
  const madeIds = new Set(made.map((m) => m.id));
  const viaBatch = (k: string): boolean => {
    let key = k;
    for (let hops = 0; hops < 64; hops++) {
      if (batch.includes(key)) return true;
      const gov = after.governing.get(key);
      if (gov === undefined || !madeIds.has(gov)) return false;
      key = after.admitter.get(key) ?? "";
    }
    return false;
  };
  const gained = after.members.some((k) => batch.includes(k) || viaBatch(k));
  if (gained) return colluderMajority(w, acked, batch, made) ? "colluder-majority" : "takeover";
  if (!undecidableFork(w, acked, made)) return "removal-decidable";
  if (soleWitnessRace(w, acked, batch)) return "sole-witness";
  return after.members.some((k) => !baseView.members.includes(k)) ? "revived-undecidable" : "removal-undecidable";
}
