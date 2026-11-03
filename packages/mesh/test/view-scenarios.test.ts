import { describe, expect, test } from "bun:test";
import { viewOfRecords } from "../src/view/engine.ts";
import { withChainNumbers } from "./fixtures/records.ts";
import type { Scenario } from "./fixtures/scenario.ts";
import { lineageScenarios } from "./fixtures/scenarios-lineage.ts";
import { staleForkScenarios } from "./fixtures/scenarios-stale.ts";
import { naiveView } from "./oracle/naive.ts";

const ORDER = ["P1", "P1b", "P2", "P3", "P4", "P5", "P6", "P7", "P7b", "P8", "P9", "P10", "P11", "P12", "P13"];
const scenarios: readonly Scenario[] = [...staleForkScenarios, ...lineageScenarios].toSorted(
  (a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id),
);
const sorted = (keys: Iterable<string>): string[] => [...keys].toSorted();

describe("M-5: the rev2 review's scenarios P1-P13 under R3", () => {
  test("cover P1-P13 with P1b and P7b", () => {
    expect(scenarios.map((s) => s.id)).toEqual(ORDER);
  });

  for (const s of scenarios) {
    const want = s.residual ?? { members: s.expectMembers, revoked: s.expectRevoked };
    const label = s.residual === undefined ? "" : ` [residual: fail closed, honest view {${sorted(s.expectMembers)}}]`;
    test(`${s.id}: ${s.title} -> {${sorted(want.members)}}${label}`, () => {
      const records = withChainNumbers(s.records);
      const view = viewOfRecords(records);
      expect(sorted(view.members)).toEqual(sorted(want.members));
      expect(sorted(view.revoked)).toEqual(sorted(want.revoked));
      for (const [key, name] of Object.entries(s.expectName ?? {})) expect(view.name.get(key)).toBe(name);
      const oracle = naiveView(records);
      expect([oracle.members, oracle.revoked, sorted(oracle.eff)]).toEqual([
        view.members,
        view.revoked,
        sorted(view.eff),
      ]);
    });
  }

  test("every residual differs from its honest view, so an improvement shows as a failure too", () => {
    for (const s of scenarios.filter((x) => x.residual !== undefined)) {
      expect(sorted(s.residual?.members ?? [])).not.toEqual(sorted(s.expectMembers));
    }
  });
});
