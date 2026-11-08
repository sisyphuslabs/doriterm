// R3 "Structure": what a record is on its own and in the DAG. Every function reads only the record, its past, and
// views of strictly smaller sets; nothing here reads testimony.

import { type PastSet, type Rec, subjectsOf } from "./dag.ts";
import type { Engine } from "./engine.ts";
import type { RuleView } from "./membership.ts";

/** A member's current Noise key in `view`: a rekey's, else its governing admission's card. */
function noiseOf(e: Engine, view: RuleView, k: string): string | undefined {
  const gov = view.governing.get(k);
  return view.rekeyed.get(k) ?? (gov === undefined ? undefined : e.dag.rec(gov).card?.noise);
}

/** Whether the card's Noise key is the current Noise key of a member other than `subject` (a twin, #90). */
function twin(e: Engine, r: Rec, before: RuleView | undefined): boolean {
  if (before === undefined) return false;
  const noise = r.card?.noise;
  return [...before.governing.keys()].some((k) => k !== r.subject && noiseOf(e, before, k) === noise);
}

/** type_ok(x, view(past(x))). */
function typeOk(e: Engine, r: Rec, before: RuleView | undefined): boolean {
  const isMember = (k: string): boolean => before?.governing.has(k) === true;
  switch (r.type) {
    case "found":
      return false;
    case "admit": {
      const subject = r.subject ?? "";
      const sameKey = before !== undefined && r.card?.noise === noiseOf(e, before, subject);
      return (!isMember(subject) || sameKey) && !twin(e, r, before);
    }
    case "name":
      return isMember(r.subject ?? "");
    case "rekey":
      return r.by === r.subject && !twin(e, r, before);
    case "revoke": {
      const subjects = subjectsOf(r);
      const known = new Set(
        e.dag.index.admissions.filter((a) => e.dag.inPast(r.id, a)).map((a) => e.dag.rec(a).subject),
      );
      return subjects.every((k) => known.has(k));
    }
    case "ack":
      return true;
  }
}

/** x.by ∈ M(x) and type_ok(x). */
function authorized(e: Engine, id: string): boolean {
  return e.once("pa", id, () => {
    const r = e.dag.rec(id);
    const before = e.before(id);
    return before?.governing.has(r.by) === true && typeOk(e, r, before);
  });
}

/** The signer's own records in past(x). */
const ownPast = (e: Engine, id: string): readonly Rec[] =>
  (e.dag.index.bySigner.get(e.dag.rec(id).by) ?? []).filter((p) => e.dag.inPast(id, p)).map((p) => e.dag.rec(p));

/** own_chain(x): every own record in the past has a smaller n, and n - 1 is one of them (n = 1: none). */
function ownChain(e: Engine, id: string): boolean {
  const r = e.dag.rec(id);
  const top = e.dag.history.ownTop(id);
  if (top === undefined) return r.n === 1;
  if (top.n >= r.n) return false;
  if (r.n === 1) return false;
  if (top.n === r.n - 1) return true;
  if (top.n < r.n - 1) return false;
  return ownPast(e, id).some((p) => p.n === r.n - 1);
}

/**
 * The signer's records with counter n - 1 in past(x): pred(x), or every branch of a merged self-fork. When n - 1 is
 * the top of the signer's chain in past(x) (always, after own_chain(x), unless counters are fractional), they are
 * exactly the records at that top.
 */
function preds(e: Engine, id: string): readonly string[] {
  const r = e.dag.rec(id);
  const top = e.dag.history.ownTop(id);
  if (top !== undefined && top.n === r.n - 1) return top.at;
  return ownPast(e, id).flatMap((p) => (p.n === r.n - 1 ? [p.id] : []));
}

/**
 * valid(x) = x.by ∈ M(x) and type_ok(x) and own_chain(x) and (x.n == 1 or valid(pred(x))). Set-independent. When the
 * signer merged its own fork, past(x) holds several records with counter x.n - 1: valid(pred(x)) needs every one valid.
 */
export function valid(e: Engine, id: string): boolean {
  return e.once("va", id, () => {
    if (id === e.dag.found.id) return true;
    if (!authorized(e, id) || !ownChain(e, id)) return false;
    if (e.dag.rec(id).n <= 1) return true;
    const before = preds(e, id);
    return before.length > 0 && before.every((p) => valid(e, p));
  });
}

/** forks(v, x): some counter names one record of x.by in {x} ∪ past(x) and another in past(v). */
export function forks(e: Engine, v: string, x: string): boolean {
  return e.once("fk", `${v}:${x}`, () => forksOnce(e, v, x));
}

function forksOnce(e: Engine, v: string, x: string): boolean {
  const by = e.dag.rec(x).by;
  const seen = new Map<number, string[]>();
  for (const p of e.dag.past(v)) {
    const r = e.dag.rec(p);
    if (r.by === by) seen.set(r.n, [...(seen.get(r.n) ?? []), p]);
  }
  for (const p of [x, ...e.dag.past(x)]) {
    const r = e.dag.rec(p);
    if (r.by === by && (seen.get(r.n) ?? []).some((other) => other !== p)) return true;
  }
  return false;
}

/** C(a, b) = past(a) ∩ past(b), kept as bits: a cache keeps one per accuser/record pair for the mesh's life. */
export function common(e: Engine, a: string, b: string): PastSet {
  return e.once("c", `${a}:${b}`, () => e.dag.common(a, b));
}

/** CM(a, b) = members(view(C(a, b))). */
export function commonMembers(e: Engine, a: string, b: string): readonly string[] {
  const c = common(e, a, b);
  return c.size === 0 ? [] : [...e.view(c).governing.keys()];
}

/**
 * lineage(k, V, C): the admissions on k's admitter chain in view V that lie outside C, admitter by admitter; it
 * stops at a member of view(C), at an admission inside C, or at a key with no governing admission in V. A walk that
 * comes back to a key it passed never stops (an admitter cycle): undefined, which is not clean, does not silence and
 * excludes no voter (contract notation).
 */
export function lineage(e: Engine, key: string, view: RuleView | undefined, C: PastSet): readonly string[] | undefined {
  const commonMembersSet = new Set(C.size === 0 ? [] : e.view(C).governing.keys());
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
