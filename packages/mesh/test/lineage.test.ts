import { expect, test } from "bun:test";
import { Dag } from "../src/view/dag.ts";
import { Engine } from "../src/view/engine.ts";
import { lineage } from "../src/view/structure.ts";
import { admit, found, revoke, withChainNumbers } from "./fixtures/records.ts";

// R3 of the reviewer's rows: in the full view X was re-admitted by D, whom X admitted, so the admitter chain is a cycle.
const e = new Engine(
  new Dag(
    withChainNumbers([
      found("F", "A"),
      admit("aX", "A", "X", ["F"]),
      admit("aD_byX", "X", "D", ["aX"]),
      revoke("vX_byA", "A", ["X"], ["aD_byX"]),
      admit("aX_byD", "D", "X", ["vX_byA"]),
    ]),
  ),
);

test("contract notation: a lineage walk that comes back to a key it passed never stops, so it has no lineage", () => {
  expect([e.full().admitter.get("X"), e.full().admitter.get("D")]).toEqual(["D", "X"]);
  expect(lineage(e, "X", e.full(), new Set(["F"]))).toBeUndefined();
  expect(lineage(e, "X", e.full(), new Set(["F", "aX", "aD_byX", "vX_byA"]))).toEqual(["aX_byD"]);
});
