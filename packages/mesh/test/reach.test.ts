import { expect, test } from "bun:test";
import { Reach } from "../src/view/reach.ts";

/** A chain r0 <- r1 <- ... <- r(n-1), appended to `reach` from `from` on. */
function chain(reach: Reach, from: number, to: number): void {
  for (let i = from; i < to; i++) reach.append(`r${i}`, i === 0 ? [] : [`r${i - 1}`]);
}

test("a common past taken before the history grows past its words stays exact as records are appended", () => {
  const reach = new Reach();
  chain(reach, 0, 200);
  const early = reach.common("r150", "r199");
  const wordsBefore = reach.words;
  chain(reach, 200, 1100);
  expect(reach.words).toBeGreaterThanOrEqual(wordsBefore * 4);
  expect([early.size, early.has("r0"), early.has("r149"), early.has("r150"), early.has("unknown")]).toEqual([
    150,
    true,
    true,
    false,
    false,
  ]);
  const leaked = Array.from({ length: 900 }, (_, i) => `r${200 + i}`).filter((id) => early.has(id));
  expect(leaked).toEqual([]);
  const late = reach.common("r1000", "r1099");
  expect([late.size, late.has("r999"), late.has("r1000"), late.has("r1099")]).toEqual([1000, true, false, false]);
});

test("a common past is the intersection of two pasts, not their union", () => {
  const reach = new Reach();
  reach.append("f", []);
  reach.append("a", ["f"]);
  reach.append("b", ["f"]);
  reach.append("x", ["a"]);
  reach.append("y", ["b"]);
  const c = reach.common("x", "y");
  expect([c.size, c.has("f"), c.has("a"), c.has("b")]).toEqual([1, true, false, false]);
});
