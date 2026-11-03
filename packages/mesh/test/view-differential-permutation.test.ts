import { describe, expect, spyOn, test } from "bun:test";
import { History } from "../src/view/chain.ts";
import type { Rec } from "../src/view/dag.ts";
import { ViewCache, viewOfRecords } from "../src/view/engine.ts";
import { randomDag } from "./fixtures/random-dag.ts";
import { readmitDag } from "./fixtures/readmit-dag.ts";
import { SCENARIOS, stored } from "./fixtures/scenarios-all.ts";
import { SEEDS, same, sameEverywhere, shape } from "./oracle/differential.ts";
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

/** The same record objects in a random order in which every prefix is past-closed (a random Kahn order). */
function arrival(g: Rng, records: readonly Rec[]): Rec[] {
  const left = new Map(records.map((x) => [x.id, x]));
  const out: Rec[] = [];
  const placed = new Set<string>();
  while (left.size > 0) {
    const ready = [...left.values()].filter((x) => x.prev.every((p) => placed.has(p)));
    const next = pick(g, ready);
    out.push(next);
    placed.add(next.id);
    left.delete(next.id);
  }
  return out;
}

describe("M-14: under any order of prev arrays and of arrival, the incremental view equals the oracle and itself", () => {
  test("every permutation is byte-identical to the oracle (every view(past(x)) too) and to the unpermuted view", () => {
    const moved: string[] = [];
    for (const [id, records] of corpus) {
      const want = shape(viewOfRecords(records));
      const cache = new ViewCache();
      viewOfRecords(records, cache);
      for (let k = 0; k < 3; k++) {
        const p = permuted(r, records);
        // Permuted prev arrays are new objects, so through the cache they also check that re-parsed copies start over.
        const ok = sameEverywhere(p) && shape(viewOfRecords(p)) === want && shape(viewOfRecords(p, cache)) === want;
        if (!ok) moved.push(id);
      }
    }
    expect([...new Set(moved)]).toEqual([]);
  }, 120_000);

  test("a warm cache answers sub-sets of what it holds, in a random arrival order, and a shuffled copy: each equals the oracle", () => {
    const accepts = spyOn(History.prototype, "accepts");
    const moved: string[] = [];
    try {
      for (const [id, records] of corpus) {
        const want = shape(viewOfRecords(records));
        const cache = new ViewCache();
        viewOfRecords(records, cache);
        const order = arrival(r, records);
        for (let n = 1; n <= order.length; n += Math.max(1, Math.floor(order.length / 6)))
          if (!same(order.slice(0, n), cache)) moved.push(`${id} @${n}`);
        if (shape(viewOfRecords(shuffled(r, records), cache)) !== want) moved.push(`${id} shuffled`);
      }
      const warm = accepts.mock.results.filter((x) => x.type === "return" && x.value === true).length;
      expect(warm).toBeGreaterThanOrEqual(corpus.length * 2);
    } finally {
      accepts.mockRestore();
    }
    expect(moved).toEqual([]);
  }, 120_000);
});
