// R3 "Structure": what a record is on its own and in the DAG. Every function reads only the record, its past, and
// views of strictly smaller sets; nothing here reads testimony.

import { MAX_REVOKE_SUBJECTS } from "../records/types.ts";
import { isAdmission, type Rec, subjectsOf } from "./dag.ts";
import type { Engine } from "./engine.ts";
import type { EngineView } from "./membership.ts";

/** type_ok(x, view(past(x))). */
function typeOk(e: Engine, r: Rec, before: EngineView | undefined): boolean {
  const members = before?.members ?? [];
  switch (r.type) {
    case "found":
      return false;
    case "admit": {
      const subject = r.subject ?? "";
      return !members.includes(subject) || r.card?.noise === before?.noise.get(subject);
    }
    case "name":
      return members.includes(r.subject ?? "");
    case "rekey":
      return r.by === r.subject;
    case "revoke": {
      const subjects = subjectsOf(r);
      const known = new Set(
        [...e.dag.past(r.id)]
          .map((p) => e.dag.rec(p))
          .filter(isAdmission)
          .map((a) => a.subject),
      );
      const sized = subjects.length > 0 && subjects.length <= MAX_REVOKE_SUBJECTS;
      return sized && new Set(subjects).size === subjects.length && subjects.every((k) => known.has(k));
    }
    case "ack":
      return true;
  }
}

/** x.by ∈ M(x) and type_ok(x). */
function authorized(e: Engine, id: string): boolean {
  return e.once(`pa:${id}`, () => {
    const r = e.dag.rec(id);
    return e.membersBefore(id).has(r.by) && typeOk(e, r, e.before(id));
  });
}

/** own_chain(x): every own record in the past has a smaller n, and n - 1 is one of them (n = 1: none). */
function ownChain(e: Engine, id: string): boolean {
  const r = e.dag.rec(id);
  const own = [...e.dag.past(id)].map((p) => e.dag.rec(p)).filter((p) => p.by === r.by);
  if (own.some((p) => p.n >= r.n)) return false;
  return r.n === 1 ? own.length === 0 : own.some((p) => p.n === r.n - 1);
}

/**
 * valid(x) = x.by ∈ M(x) and type_ok(x) and own_chain(x) and (x.n == 1 or valid(pred(x))). Set-independent. When the
 * signer merged its own fork, past(x) holds several records with counter x.n - 1: valid(pred(x)) needs every one valid.
 */
export function valid(e: Engine, id: string): boolean {
  return e.once(`va:${id}`, () => {
    if (id === e.dag.found.id) return true;
    if (!authorized(e, id) || !ownChain(e, id)) return false;
    const r = e.dag.rec(id);
    if (r.n <= 1) return true;
    const preds = [...e.dag.past(id)].filter((p) => e.dag.rec(p).by === r.by && e.dag.rec(p).n === r.n - 1);
    return preds.length > 0 && preds.every((p) => valid(e, p));
  });
}

/** forks(v, x): some counter names one record of x.by in {x} ∪ past(x) and another in past(v). */
export function forks(e: Engine, v: string, x: string): boolean {
  const by = e.dag.rec(x).by;
  const seen = new Map<number, string>();
  for (const p of e.dag.past(v)) {
    const r = e.dag.rec(p);
    if (r.by === by) seen.set(r.n, p);
  }
  for (const p of [x, ...e.dag.past(x)]) {
    const r = e.dag.rec(p);
    if (r.by !== by) continue;
    const other = seen.get(r.n);
    if (other !== undefined && other !== p) return true;
  }
  return false;
}

/** C(a, b) = past(a) ∩ past(b). */
export function common(e: Engine, a: string, b: string): ReadonlySet<string> {
  return e.once(`c:${a}:${b}`, () => {
    const pb = e.dag.past(b);
    return new Set([...e.dag.past(a)].filter((id) => pb.has(id)));
  });
}

/** CM(a, b) = members(view(C(a, b))). */
export function commonMembers(e: Engine, a: string, b: string): readonly string[] {
  const c = common(e, a, b);
  return c.size === 0 ? [] : e.view(c).members;
}

/**
 * lineage(k, V, C): the admissions on k's admitter chain in view V that lie outside C, admitter by admitter; it
 * stops at a member of view(C), at an admission inside C, or at a key with no governing admission in V. A walk that
 * comes back to a key it passed never stops (an admitter cycle): undefined, which is not clean, does not silence and
 * excludes no voter (contract notation).
 */
export function lineage(
  e: Engine,
  key: string,
  view: EngineView | undefined,
  C: ReadonlySet<string>,
): readonly string[] | undefined {
  const commonMembersSet = new Set(C.size === 0 ? [] : e.view(C).members);
  const out: string[] = [];
  const passed = new Set<string>();
  for (let k = key; !passed.has(k);) {
    passed.add(k);
    if (commonMembersSet.has(k)) return out;
    const gov = view?.governing.get(k);
    if (gov === undefined || C.has(gov)) return out;
    out.push(gov);
    k = e.dag.rec(gov).by;
  }
  return undefined;
}
