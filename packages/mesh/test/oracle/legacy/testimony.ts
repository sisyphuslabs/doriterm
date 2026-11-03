// R3 testimony: who may vote on a conflict, whose records testify, and the verdict of one accuser on one record, at
// level 0 (every valid accuser) or level 1 (accusers with standing). The level's accusers come in as `acc`, so this
// module reads no level's outcome itself.

import { subjectsOf } from "./dag.ts";
import type { Engine } from "./engine.ts";
import { common, commonMembers, forks, lineage, valid } from "./structure.ts";

export type Level = 0 | 1;
export type Verdict = "defeated" | "tie" | "stands";
/** The accusers of a level: accusers0 at level 0, the accusers with standing at level 1. */
export type AccusersOf = (e: Engine, S: ReadonlySet<string>, id: string) => readonly string[];

interface Testimony {
  readonly e: Engine;
  readonly S: ReadonlySet<string>;
  readonly level: Level;
  readonly acc: AccusersOf;
}

/**
 * voters(v, x) = CM(v, x) \ {x.by, v.by} \ { g.by : g ∈ lineage(x.by, view(past(x)), C) ∪ lineage(v.by, view(past(v)), C) };
 * voters1(v, x) = voters(v, x) \ v.subjects.
 */
export function voters(e: Engine, v: string, x: string, level: Level): readonly string[] {
  const rv = e.dag.rec(v);
  const rx = e.dag.rec(x);
  const C = common(e, v, x);
  const excluded = new Set([rx.by, rv.by, ...(level === 1 ? subjectsOf(rv) : [])]);
  for (const [k, id] of [
    [rx.by, x],
    [rv.by, v],
  ] as const) {
    for (const g of lineage(e, k, e.before(id), C) ?? []) excluded.add(e.dag.rec(g).by);
  }
  return commonMembers(e, v, x).filter((k) => !excluded.has(k));
}

/**
 * silences0(r, w) = r.by ∉ revoked(view(past(w))) and accusers0(r) = ∅ and the whole lineage of r.by outside C(r, w)
 * is unaccused at level 0; silences(r, w) is the same at level 1 without the "already revoked" escape.
 */
function silences(t: Testimony, r: string, w: string): boolean {
  const { e, S, acc } = t;
  const by = e.dag.rec(r).by;
  if (t.level === 0 && (e.before(w)?.revoked ?? []).includes(by)) return false;
  if (acc(e, S, r).length > 0) return false;
  const chain = lineage(e, by, e.before(r), common(e, r, w));
  return chain !== undefined && chain.every((g) => acc(e, S, g).length === 0);
}

/** testifies(w) = valid(w) and ¬∃ r ∈ accusers(w): silences(r, w). */
function testifies(t: Testimony, w: string): boolean {
  return t.e.cached(t.S, `t${t.level}:${w}`, () => {
    if (!valid(t.e, w)) return false;
    return !t.acc(t.e, t.S, w).some((r) => silences(t, r, w));
  });
}

/** saw(p, a, b) = ∃ w ∈ S, w.by == p, a ∈ past(w), b ∉ past(w), testifies(w). */
function saw(t: Testimony, p: string, a: string, b: string): boolean {
  for (const w of t.S) {
    const past = t.e.dag.past(w);
    if (t.e.dag.rec(w).by === p && past.has(a) && !past.has(b) && testifies(t, w)) return true;
  }
  return false;
}

/** support(a, b) = |{ p ∈ pool : saw(p, a, b) and not saw(p, b, a) }|. */
const support = (t: Testimony, a: string, b: string, pool: readonly string[]): number =>
  pool.filter((p) => saw(t, p, a, b) && !saw(t, p, b, a)).length;

export const supportAt = (
  e: Engine,
  S: ReadonlySet<string>,
  a: string,
  b: string,
  pool: readonly string[],
  level: Level,
  acc: AccusersOf,
): number => support({ e, S, level, acc }, a, b, pool);

/**
 * verdict(v, x): defeated on a fork or strictly more testimony for v; at level 1 a non-revoke with no testimony either
 * way (0:0) is a tie (fail closed); otherwise it stands.
 */
export function verdict(
  e: Engine,
  S: ReadonlySet<string>,
  v: string,
  x: string,
  level: Level,
  acc: AccusersOf,
): Verdict {
  return e.cached(S, `vd${level}:${v}:${x}`, (): Verdict => {
    if (forks(e, v, x)) return "defeated";
    const t: Testimony = { e, S, level, acc };
    const pool = voters(e, v, x, level);
    const forX = support(t, x, v, pool);
    const forV = support(t, v, x, pool);
    if (forV > forX) return "defeated";
    const isRevoke = e.dag.rec(x).type === "revoke";
    return level === 1 && !isRevoke && forX === 0 && forV === 0 ? "tie" : "stands";
  });
}
