import { describe, expect, test } from "bun:test";
import type { Rec } from "../src/view/dag.ts";
import { viewOfRecords } from "../src/view/engine.ts";
import { ack, admit, type Draft, found, revoke, withChainNumbers } from "./fixtures/records.ts";
import { naiveView } from "./oracle/naive.ts";

/**
 * A founds and admits K and B; A revokes K and B acks it, so K's concurrent first mint Z1 is defeated. On that branch
 * K's mints admit each other `depth` deep, each revoking the mint `window` back so the branch stays within 12 members,
 * and the last one revokes the founder. Its revoke's lineage walk must reach the defeated Z1 at any depth.
 */
function mintChain(depth: number, window = 8): Rec[] {
  const out: Draft[] = [
    found("F", "A"),
    admit("aK", "A", "K", ["F"]),
    admit("aB", "A", "B", ["aK"]),
    revoke("vK", "A", ["K"], ["aB"]),
    ack("kB", "B", ["vK"]),
  ];
  let last = "aB";
  let by = "K";
  for (let i = 1; i <= depth; i++) {
    out.push(admit(`m${i}`, by, `Z${i}`, [last]));
    last = `m${i}`;
    by = `Z${i}`;
    if (i > window) {
      out.push(revoke(`r${i}`, by, [`Z${i - window}`], [last]));
      last = `r${i}`;
    }
  }
  out.push(revoke("x", by, ["A"], [last]));
  return withChainNumbers(out);
}

describe("contract: the revoke lineage walk goes all the way to the founding record", () => {
  for (const depth of [1, 9, 64, 65, 70, 100]) {
    test(`a revoke of the founder by a mint ${depth} admissions below a defeated mint is void`, () => {
      const view = viewOfRecords(mintChain(depth));
      expect([view.eff.has("x"), view.members, view.revoked]).toEqual([false, ["A", "B"], ["K"]]);
    });
  }

  test("the oracle agrees past the old 64-hop bound", () => {
    const records = mintChain(65);
    const oracle = naiveView(records);
    expect([oracle.eff.includes("x"), oracle.members, oracle.revoked]).toEqual([false, ["A", "B"], ["K"]]);
  });
});
