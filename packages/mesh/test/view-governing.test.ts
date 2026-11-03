import { expect, test } from "bun:test";
import { hashOf } from "../src/records/codec.ts";
import type { Signed } from "../src/records/types.ts";
import { viewOf } from "../src/view/engine.ts";
import { withChainNumbers } from "./fixtures/records.ts";
import { cardScenarios } from "./fixtures/scenarios-cards.ts";
import { reviewerScenarios } from "./fixtures/scenarios-reviewer.ts";
import { keyOf, signScenario } from "./fixtures/signed.ts";

function signed(rows: typeof cardScenarios, id: string) {
  const scenario = signScenario(withChainNumbers(rows.find((s) => s.id === id)?.records ?? []));
  const hash = (recordId: string): string => {
    const record: Signed | undefined = scenario.byId.get(recordId);
    if (record === undefined) throw new RangeError(recordId);
    return hashOf(record);
  };
  return { view: viewOf(scenario.records), hash };
}

test("View.governing: a re-admitted member is governed by its re-admission, not its first admit (R3)", () => {
  const { view, hash } = signed(reviewerScenarios, "R3");
  expect(view.governing).toEqual(
    new Map([
      [keyOf("A").pub, hash("F")],
      [keyOf("X").pub, hash("aX_byD")],
      [keyOf("D").pub, hash("aD_byX")],
    ]),
  );
});

test("View.governing names members only: the over-cap keys of A13 have none", () => {
  const { view, hash } = signed(cardScenarios, "A13");
  expect([...view.governing.keys()].toSorted()).toEqual([...view.members].toSorted());
  expect(view.governing.get(keyOf("M4").pub)).toBe(hash("qM4"));
  for (const k of view.overCap) expect(view.governing.has(k)).toBe(false);
  expect(view.overCap.size).toBe(2);
});
