import { describe, expect, test } from "bun:test";
import { door } from "../src/door.ts";
import type { Signed } from "../src/records/types.ts";
import { viewOf } from "../src/view/engine.ts";
import { admit, type Draft, found, name, revoke, withChainNumbers } from "./fixtures/records.ts";
import { lineageScenarios } from "./fixtures/scenarios-lineage.ts";
import { staleForkScenarios } from "./fixtures/scenarios-stale.ts";
import { signScenario } from "./fixtures/signed.ts";

const r2: readonly Draft[] = [
  found("F", "A"),
  admit("aB", "A", "B", ["F"]),
  admit("aX", "A", "X", ["aB"]),
  revoke("vX_byB", "B", ["X"], ["aX"]),
  name("nB_byA", "A", "B", ["vX_byB"]),
  revoke("xB_byX", "X", ["B"], ["aX"]),
  revoke("xA_byX", "X", ["A"], ["aX"]),
  admit("xZ_byX", "X", "Z", ["aX"]),
];

const byId = new Map([...staleForkScenarios, ...lineageScenarios].map((s) => [s.id, s.records]));
const shape = (id: string): readonly Draft[] => byId.get(id) ?? [];

/**
 * E-BACKDATE (design section 11 PR 9) on real signed records: the honest records are stored through the door, then
 * the revoked key's pre-signed backdated records (ids starting with `x`) are injected through the door. The honest
 * view where the fork is decidable, the fail-closed view where it is not; never a revoked or minted key.
 */
const SHAPES = [
  { id: "R2", records: r2, members: ["A", "B"] },
  { id: "P3", records: shape("P3"), members: ["A", "C", "G"] },
  { id: "P4", records: shape("P4"), members: ["A", "C", "G"] },
  { id: "P8", records: shape("P8"), members: [] },
  { id: "P13", records: shape("P13"), members: [] },
  { id: "P1 (N = 2)", records: shape("P1"), members: ["A"] },
  { id: "P1b (N = 2)", records: shape("P1b"), members: [] },
  { id: "P2 (N = 2, grew to 4)", records: shape("P2"), members: [] },
] as const;

describe("E-BACKDATE shapes through the door and viewOf", () => {
  for (const s of SHAPES) {
    test(`${s.id}: injected backdated records leave {${s.members.join(", ")}}`, () => {
      expect(s.records.length).toBeGreaterThan(0);
      const records = withChainNumbers(s.records);
      const signed = signScenario(records);
      const injected = new Set(records.filter((r) => r.id.startsWith("x")).map((r) => r.id));
      const stored: Signed[] = [];
      const offer = (id: string): void => {
        const record = signed.byId.get(id);
        if (record === undefined) throw new RangeError(id);
        expect(door(record, stored)).toEqual({ ok: true });
        stored.push(record);
      };
      for (const r of records.filter((x) => !injected.has(x.id))) offer(r.id);
      const honest = viewOf(stored);
      for (const r of records.filter((x) => injected.has(x.id))) offer(r.id);
      const view = viewOf(stored);
      const names = [...view.members].map((k) => signed.nameOfKey.get(k) ?? k).toSorted();
      expect(names).toEqual([...s.members].toSorted());
      for (const k of view.members) expect(honest.members.has(k)).toBe(true);
    });
  }
});
