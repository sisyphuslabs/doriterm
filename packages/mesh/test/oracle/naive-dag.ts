// What the independent evaluator (naive.ts) shares with nothing else: bitmask DAG helpers (past sets, topological and
// canonical order). It imports no rule logic of `src/`, only the record shape.

import type { Rec } from "../../src/view/dag.ts";

export type { Rec } from "../../src/view/dag.ts";
export const MAX_MEMBERS = 12;

export const has = (mask: bigint, i: number): boolean => ((mask >> BigInt(i)) & 1n) === 1n;
export const popcount = (mask: bigint): number => mask.toString(2).replaceAll("0", "").length;
export const subjectsOf = (r: Rec): readonly string[] => r.subjects ?? (r.subject === undefined ? [] : [r.subject]);
export const isAdmission = (r: Rec): boolean => r.type === "found" || r.type === "admit";

/** Depth-first topological order of record indices. */
export function topo(records: readonly Rec[], index: ReadonlyMap<string, number>): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const visit = (i: number): void => {
    if (seen.has(i)) return;
    seen.add(i);
    for (const p of records[i]?.prev ?? []) visit(index.get(p) ?? -1);
    out.push(i);
  };
  records.forEach((_, i) => visit(i));
  return out;
}

/** Bitmask of every record's past. */
export function pasts(records: readonly Rec[], index: ReadonlyMap<string, number>, order: readonly number[]): bigint[] {
  const past: bigint[] = records.map(() => 0n);
  for (const i of order) {
    let m = 0n;
    for (const p of records[i]?.prev ?? []) {
      const j = index.get(p) ?? -1;
      m |= (1n << BigInt(j)) | (past[j] ?? 0n);
    }
    past[i] = m;
  }
  return past;
}

/** Kahn's algorithm over the indices in S, smallest id first among the ready ones. */
export function canonical(records: readonly Rec[], inS: readonly number[], past: readonly bigint[]): number[] {
  const left = new Set(inS);
  const out: number[] = [];
  while (left.size > 0) {
    const ready = [...left]
      .filter((i) => [...left].every((j) => j === i || !has(past[i] ?? 0n, j)))
      .toSorted((a, b) => ((records[a]?.id ?? "") < (records[b]?.id ?? "") ? -1 : 1));
    const next = ready[0];
    if (next === undefined) break;
    out.push(next);
    left.delete(next);
  }
  return out;
}
