import { expect, test } from "bun:test";
import type { Rec } from "../src/view/dag.ts";
import { viewOfRecords } from "../src/view/engine.ts";
import { withChainNumbers } from "./fixtures/records.ts";
import { cardScenarios } from "./fixtures/scenarios-cards.ts";
import { colluderScenarios } from "./fixtures/scenarios-colluders.ts";
import { conflictScenarios } from "./fixtures/scenarios-conflict.ts";
import { lineageScenarios } from "./fixtures/scenarios-lineage.ts";
import { reviewerScenarios } from "./fixtures/scenarios-reviewer.ts";
import { selfForkScenarios } from "./fixtures/scenarios-self-fork.ts";
import { staleForkScenarios } from "./fixtures/scenarios-stale.ts";
import { attack, honestHistory, pick, type Rng, rng } from "./sim/world.ts";

const shuffled = <T>(r: Rng, items: readonly T[]): T[] =>
  items
    .map((item) => ({ item, key: r.next() }))
    .toSorted((a, b) => a.key - b.key)
    .map(({ item }) => item);

const sorted = <T>(m: ReadonlyMap<string, T>): [string, T][] => [...m].toSorted();
const shape = (records: readonly Rec[]): string => {
  const v = viewOfRecords(records);
  return JSON.stringify([v.members, v.overCap, v.revoked, sorted(v.noise), sorted(v.admitter), [...v.eff].toSorted()]);
};

function adversarialDag(r: Rng): readonly Rec[] {
  const w = honestHistory(r, 10);
  const members = w.full().members.filter((k) => k !== "A");
  const pool = w.records.map((x) => x.id);
  if (members.length > 0) attack(r, w, [pick(r, members)], ["A"], pool, 6);
  return w.records;
}

const r = rng(20261104);
const corpus: readonly (readonly [string, readonly Rec[]])[] = [
  ...[...staleForkScenarios, ...lineageScenarios, ...reviewerScenarios, ...conflictScenarios, ...colluderScenarios]
    .concat(cardScenarios, selfForkScenarios)
    .map((s) => [s.id, withChainNumbers([...s.records, ...(s.after ?? [])])] as const),
  ...Array.from({ length: 150 }, (_, i) => [`sim ${i}`, adversarialDag(r)] as const),
];

test("G1: the view is the same under every reordering of prev arrays and of record arrival", () => {
  const moved: string[] = [];
  for (const [id, records] of corpus) {
    const want = shape(records);
    for (let k = 0; k < 4; k++) {
      const permuted: Rec[] = [];
      for (const x of shuffled(r, records)) permuted.push({ ...x, prev: shuffled(r, x.prev) });
      if (shape(permuted) !== want) moved.push(id);
    }
  }
  expect([...new Set(moved)]).toEqual([]);
}, 120_000);
