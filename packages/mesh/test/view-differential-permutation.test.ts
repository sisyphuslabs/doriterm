import { describe, expect, test } from "bun:test";
import type { Rec } from "../src/view/dag.ts";
import { ViewCache, viewOfRecords } from "../src/view/engine.ts";
import { randomDag } from "./fixtures/random-dag.ts";
import { readmitDag } from "./fixtures/readmit-dag.ts";
import { SCENARIOS, stored } from "./fixtures/scenarios-all.ts";
import { SEEDS, sameEverywhere, shape } from "./oracle/differential.ts";
import { attack, honestHistory, pick, type Rng, rng } from "./sim/world.ts";

const shuffled = <T>(r: Rng, items: readonly T[]): T[] =>
  items
    .map((item) => ({ item, key: r.next() }))
    .toSorted((a, b) => a.key - b.key)
    .map(({ item }) => item);

/** The same records arriving in another order, each with its prev array in another order. */
function permuted(r: Rng, records: readonly Rec[]): Rec[] {
  const out: Rec[] = [];
  for (const x of shuffled(r, records)) out.push({ ...x, prev: shuffled(r, x.prev) });
  return out;
}

function adversarial(r: Rng): readonly Rec[] {
  const w = honestHistory(r, 8 + Math.floor(r.next() * 10));
  const members = w.full().members;
  if (members.length > 1)
    attack(
      r,
      w,
      [pick(r, members)],
      members,
      w.records.map((x) => x.id),
      6,
    );
  return w.records;
}

const r = rng(20261104);
const corpus: readonly (readonly [string, readonly Rec[]])[] = [
  ...SCENARIOS.map((s) => [s.id, stored(s)] as const),
  ...SEEDS.flatMap((seed) => {
    const g = rng(seed + 4000);
    return [
      [`readmit ${seed}`, readmitDag(g, 40)] as const,
      [`random ${seed}`, randomDag(g, 32)] as const,
      [`adversarial ${seed}`, adversarial(g)] as const,
    ];
  }),
];

describe("M-14: under any order of prev arrays and of arrival, the incremental view equals the oracle and itself", () => {
  test("every permutation is byte-identical to the oracle (every view(past(x)) too) and to the unpermuted view", () => {
    const moved: string[] = [];
    for (const [id, records] of corpus) {
      const want = shape(viewOfRecords(records));
      const cache = new ViewCache();
      viewOfRecords(records, cache);
      for (let k = 0; k < 3; k++) {
        const p = permuted(r, records);
        const ok = sameEverywhere(p) && shape(viewOfRecords(p)) === want && shape(viewOfRecords(p, cache)) === want;
        if (!ok) moved.push(id);
      }
    }
    expect([...new Set(moved)]).toEqual([]);
  }, 120_000);
});
