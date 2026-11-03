// An independent second implementation of R3 (contract v1.5 "Membership"), written from the rule text and not from
// `src/view`: bitmask sets, one generic function per level, no memo shared with the reference. It evaluates every
// distinct past set and every pairwise meet bottom-up in increasing size, so view(past(x)) and the view of every common
// past are ready before any set that contains x. Test-only: `src/` never imports it.

import { canonical, has, isAdmission, MAX_MEMBERS, pasts, popcount, type Rec, subjectsOf, topo } from "./naive-dag.ts";

export interface Lite {
  readonly members: readonly string[];
  readonly revoked: readonly string[];
  readonly noise: ReadonlyMap<string, string>;
  readonly admitter: ReadonlyMap<string, string>;
  readonly governing: ReadonlyMap<string, number>;
  readonly eff: readonly string[];
}
type Vd = "defeated" | "tie" | "stands";
type Own = "invalid" | "defeated" | "tie" | "clear";
const EMPTY: Lite = { members: [], revoked: [], noise: new Map(), admitter: new Map(), governing: new Map(), eff: [] };

export function naiveView(records: readonly Rec[]): Lite {
  const index = new Map(records.map((r, i) => [r.id, i]));
  const order = topo(records, index);
  const past = pasts(records, index, order);
  const P = (i: number): bigint => past[i] ?? 0n;
  const full = (1n << BigInt(records.length)) - 1n;
  const family = [...new Set([...past, ...past.flatMap((a) => past.map((b) => a & b)), full])].toSorted(
    (a, b) => popcount(a) - popcount(b),
  );
  const done = new Map<bigint, Lite>([[0n, EMPTY]]);
  const rec = (i: number): Rec => {
    const r = records[i];
    if (r === undefined) throw new RangeError(`record ${i}`);
    return r;
  };
  const viewOf = (mask: bigint): Lite => done.get(mask) ?? EMPTY;
  const before = (i: number): Lite => viewOf(P(i));
  const pauth = (i: number): boolean => {
    const r = rec(i);
    const b = before(i);
    if (!b.members.includes(r.by)) return false;
    if (r.type === "admit" && b.members.includes(r.subject ?? ""))
      return r.card?.noise === b.noise.get(r.subject ?? "");
    if (r.type === "name") return b.members.includes(r.subject ?? "");
    if (r.type === "rekey") return r.by === r.subject;
    if (r.type === "revoke") {
      const s = subjectsOf(r);
      const known = new Set(order.filter((j) => has(P(i), j) && isAdmission(rec(j))).map((j) => rec(j).subject));
      return s.every((k) => known.has(k));
    }
    return true;
  };
  const chained = (i: number): boolean => {
    const c = rec(i).n;
    const mine = order.filter((j) => has(P(i), j) && rec(j).by === rec(i).by);
    if (mine.some((j) => rec(j).n >= c)) return false;
    return c === 1 ? mine.length === 0 : mine.some((j) => rec(j).n === c - 1);
  };
  const validMemo = new Map<number, boolean>();
  const valid = (i: number): boolean => {
    const m = validMemo.get(i);
    if (m !== undefined) return m;
    const r = rec(i);
    let ok = r.type === "found" || (pauth(i) && chained(i));
    if (ok && r.type !== "found" && r.n > 1) {
      const preds = order.filter((j) => has(P(i), j) && rec(j).by === r.by && rec(j).n === r.n - 1);
      ok = preds.length > 0 && preds.every(valid);
    }
    validMemo.set(i, ok);
    return ok;
  };
  const meet = (a: number, b: number): bigint => P(a) & P(b);
  const conc = (a: number, b: number): boolean => a !== b && !has(P(a), b) && !has(P(b), a);
  // A walk that meets a key twice is an admitter cycle: it never stops, so it has no lineage (contract notation).
  const lineage = (key: string, view: Lite, C: bigint): number[] | undefined => {
    const cm = viewOf(C).members;
    const out: number[] = [];
    const seen: string[] = [];
    let k = key;
    while (!seen.includes(k)) {
      seen.push(k);
      if (cm.includes(k)) return out;
      const g = view.governing.get(k);
      if (g === undefined || has(C, g)) return out;
      out.push(g);
      k = rec(g).by;
    }
    return undefined;
  };
  const forks = (v: number, x: number): boolean => {
    const by = rec(x).by;
    const mine = [x, ...order.filter((j) => has(P(x), j))].filter((j) => rec(j).by === by);
    const theirs = order.filter((j) => has(P(v), j) && rec(j).by === by);
    return mine.some((a) => theirs.some((b) => rec(a).n === rec(b).n && a !== b));
  };
  for (const S of family) {
    if (S === 0n) continue;
    const inS = order.filter((i) => has(S, i));
    const accusers0 = (x: number): number[] =>
      inS.filter((v) => rec(v).type === "revoke" && subjectsOf(rec(v)).includes(rec(x).by) && conc(v, x) && valid(v));
    const votersOf = (v: number, x: number, lvl: 0 | 1): string[] => {
      const C = meet(v, x);
      const out = new Set([rec(x).by, rec(v).by, ...(lvl === 1 ? subjectsOf(rec(v)) : [])]);
      for (const [k, i] of [
        [rec(x).by, x],
        [rec(v).by, v],
      ] as const) {
        for (const g of lineage(k, before(i), C) ?? []) out.add(rec(g).by);
      }
      return viewOf(C).members.filter((k) => !out.has(k));
    };
    const level = (acc: (i: number) => number[], lvl: 0 | 1) => {
      const silences = (r: number, w: number): boolean => {
        if (lvl === 0 && before(w).revoked.includes(rec(r).by)) return false;
        if (acc(r).length > 0) return false;
        return lineage(rec(r).by, before(r), meet(r, w))?.every((g) => acc(g).length === 0) ?? false;
      };
      const testifies = (w: number): boolean => valid(w) && !acc(w).some((r) => silences(r, w));
      const saw = (p: string, a: number, b: number): boolean =>
        inS.some((w) => rec(w).by === p && has(P(w), a) && !has(P(w), b) && testifies(w));
      const support = (a: number, b: number, pool: readonly string[]): number =>
        pool.filter((p) => saw(p, a, b) && !saw(p, b, a)).length;
      return (v: number, x: number): Vd => {
        if (forks(v, x)) return "defeated";
        const pool = votersOf(v, x, lvl);
        const forX = support(x, v, pool);
        const forV = support(v, x, pool);
        if (forV > forX) return "defeated";
        return lvl === 1 && rec(x).type !== "revoke" && forX === 0 && forV === 0 ? "tie" : "stands";
      };
    };
    const verdict0 = level(accusers0, 0);
    const clean0 = (r: number, C: bigint): boolean =>
      lineage(rec(r).by, before(r), C)?.every((g) => !accusers0(g).some((u) => verdict0(u, g) === "defeated")) ?? false;
    const standing = (v: number, x: number): boolean =>
      clean0(v, meet(v, x)) && !accusers0(v).some((u) => clean0(u, meet(u, v)) && verdict0(u, v) === "defeated");
    const accusers1 = (x: number): number[] => accusers0(x).filter((v) => standing(v, x));
    const verdict1 = level(accusers1, 1);
    const own = (x: number): Own => {
      if (rec(x).type === "found") return "clear";
      if (!valid(x)) return "invalid";
      const vds = new Set(accusers1(x).map((v) => verdict1(v, x)));
      return vds.has("defeated") ? "defeated" : vds.has("tie") ? "tie" : "clear";
    };
    const statusOf = new Map<number, "eff" | "tie" | "void">();
    const status = (x: number): "eff" | "tie" | "void" => {
      const rx = rec(x);
      if (rx.type === "found") return "eff";
      const o = own(x);
      if (o === "invalid" || o === "defeated") return "void";
      if (rx.type === "revoke") {
        let key = rx.by;
        let b = before(x);
        for (;;) {
          const g = b.governing.get(key);
          if (g === undefined) return "void";
          if (rec(g).type === "found") break;
          if (own(g) === "invalid" || own(g) === "defeated") return "void";
          key = rec(g).by;
          b = before(g);
        }
      } else {
        const g = before(x).governing.get(rx.by);
        if (g === undefined || statusOf.get(g) !== "eff") return "void";
      }
      return o === "tie" ? "tie" : "eff";
    };
    const canon = canonical(records, inS, past);
    for (const i of canon) statusOf.set(i, status(i));
    done.set(
      S,
      lite(
        records,
        canon,
        past,
        inS.filter((i) => statusOf.get(i) === "eff"),
      ),
    );
  }
  return viewOf(full);
}

/** membership() over the effective records, in canonical order. */
function lite(
  records: readonly Rec[],
  canon: readonly number[],
  past: readonly bigint[],
  eff: readonly number[],
): Lite {
  const rec = (i: number): Rec => {
    const r = records[i];
    if (r === undefined) throw new RangeError(`record ${i}`);
    return r;
  };
  const effRev = (k: string): number[] => eff.filter((v) => rec(v).type === "revoke" && subjectsOf(rec(v)).includes(k));
  const keys = [...new Set(canon.filter((i) => isAdmission(rec(i))).map((i) => rec(i).subject ?? ""))];
  const gov: [string, number][] = [];
  for (const k of keys) {
    const admits = (a: number): boolean => eff.includes(a) && isAdmission(rec(a)) && rec(a).subject === k;
    const g = canon.find((a) => admits(a) && effRev(k).every((v) => has(past[a] ?? 0n, v)));
    if (g !== undefined) gov.push([k, g]);
  }
  const governed = gov.toSorted((a, b) => canon.indexOf(a[1]) - canon.indexOf(b[1]));
  const ranked = governed.slice(0, MAX_MEMBERS);
  const noise = new Map<string, string>();
  const admitter = new Map<string, string>(governed.map(([k, g]) => [k, rec(g).by]));
  const governing = new Map<string, number>(governed);
  for (const [k, g] of ranked) {
    const rekeys = eff.filter((r) => rec(r).type === "rekey" && rec(r).subject === k && has(past[r] ?? 0n, g));
    const tops = rekeys.filter((r) => !rekeys.some((o) => o !== r && has(past[o] ?? 0n, r)));
    const top = tops.map(rec).toSorted((a, b) => (a.id < b.id ? -1 : 1))[0];
    noise.set(k, (top ?? rec(g)).card?.noise ?? "?");
  }
  const members = ranked.map(([k]) => k);
  const revoked = keys.filter((k) => !gov.some(([g]) => g === k) && effRev(k).length > 0).toSorted();
  return { members, revoked, noise, admitter, governing, eff: eff.map((i) => rec(i).id) };
}
