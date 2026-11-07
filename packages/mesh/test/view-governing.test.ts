import { expect, test } from "bun:test";
import { hashOf } from "../src/records/codec.ts";
import type { Signed } from "../src/records/types.ts";
import { viewOf } from "../src/view/engine.ts";
import { withChainNumbers } from "./fixtures/records.ts";
import { cardScenarios } from "./fixtures/scenarios-cards.ts";
import { reviewerScenarios } from "./fixtures/scenarios-reviewer.ts";
import { keyOf, signScenario } from "./fixtures/signed.ts";
import { naiveView } from "./oracle/naive.ts";

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

test("View.governing and View.admitter cover every governed key: A13's fourteen members", () => {
  const { view, hash } = signed(cardScenarios, "A13");
  const B = keyOf("B").pub;
  expect([...view.governing.keys()].toSorted()).toEqual([...view.members].toSorted());
  expect(view.members.size).toBe(14);
  expect([view.governing.get(keyOf("M5").pub), view.admitter.get(keyOf("M5").pub)]).toEqual([hash("qM5"), B]);
  expect([view.governing.get(keyOf("M6").pub), view.admitter.get(keyOf("M6").pub)]).toEqual([hash("qM6"), B]);
});

test("the oracle reads the same admitters past the twelfth member", () => {
  const records = withChainNumbers(cardScenarios.find((s) => s.id === "A13")?.records ?? []);
  const oracle = naiveView(records);
  expect([oracle.admitter.get("M5"), oracle.admitter.get("M6"), oracle.members.length]).toEqual(["B", "B", 14]);
});
