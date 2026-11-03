import { describe, expect, test } from "bun:test";
import { checkName, fallbacks } from "../src/names.ts";
import { witnessPoolOfRecords } from "../src/pool.ts";
import { withChainNumbers } from "./fixtures/records.ts";
import { lineageScenarios } from "./fixtures/scenarios-lineage.ts";
import { staleForkScenarios } from "./fixtures/scenarios-stale.ts";
import { rng } from "./sim/world.ts";

describe("R-9: herdr-core's machine-name rule", () => {
  const VECTORS = [
    ["macbook", true],
    ["MacBook", false],
    ["mac book", false],
    ["_box", false],
    ["-box", false],
    ["box.", true],
    ["a".repeat(32), true],
    ["a".repeat(33), false],
    ["t7", false],
    ["t1b", false],
    ["t0", true],
    ["tx", true],
    ["t", true],
    ["7", true],
    ["minipc-k7tq", true],
    ["é", false],
    ["", false],
  ] as const;
  for (const [name, want] of VECTORS)
    test(`${JSON.stringify(name)} -> ${want}`, () => expect(checkName(name)).toBe(want));

  test("every fallback of 5000 random valid names passes and differs from the name", () => {
    const r = rng(20261109);
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789-_.";
    const b32 = "abcdefghijklmnopqrstuvwxyz234567";
    const draw = (chars: string, length: number): string =>
      Array.from({ length }, () => chars[Math.floor(r.next() * chars.length)] ?? "a").join("");
    let bad = 0;
    for (let i = 0; i < 5000; i++) {
      const name = draw(alphabet, 1 + Math.floor(r.next() * 32));
      if (!checkName(name)) continue;
      if (fallbacks(name, draw(b32, 26)).some((f) => !checkName(f) || f === name)) bad++;
    }
    expect(bad).toBe(0);
  });
});

describe("M-15: the revoke-time witness pool at each honest revoke", () => {
  const scenarios = [...staleForkScenarios, ...lineageScenarios];
  const WANT = {
    P1: "empty",
    P2: "empty",
    P6: "empty",
    P7: "empty",
    P8: "empty",
    P7b: "non-empty",
    P9: "non-empty",
  } as const;
  for (const [id, want] of Object.entries(WANT)) {
    test(`${id}: ${want}`, () => {
      const records = withChainNumbers(scenarios.find((s) => s.id === id)?.records ?? []);
      const v = records.find((r) => r.type === "revoke" && !r.id.startsWith("x"));
      expect(v).toBeDefined();
      if (v === undefined) return;
      const pool = witnessPoolOfRecords(
        records.filter((r) => r.id !== v.id && isAncestor(records, r.id, v.prev)),
        v.by,
        v.subjects ?? [],
      );
      const sizes = [...pool.values()].map((p) => p.length);
      expect(sizes.some((n) => n === 0)).toBe(want === "empty");
      if (want === "non-empty") expect([...pool.values()].flat()).toEqual(["A"]);
    });
  }
});

function isAncestor(
  records: readonly { id: string; prev: readonly string[] }[],
  id: string,
  from: readonly string[],
): boolean {
  const byId = new Map(records.map((r) => [r.id, r]));
  const stack = [...from];
  const seen = new Set<string>();
  for (let p = stack.pop(); p !== undefined; p = stack.pop()) {
    if (p === id) return true;
    if (seen.has(p)) continue;
    seen.add(p);
    stack.push(...(byId.get(p)?.prev ?? []));
  }
  return false;
}
