import { describe, expect, test } from "bun:test";
import { caretLeft, clampOffset, type DragState, landingIndex, landingLeft, shiftOf } from "./tab-drop-geometry.ts";

// Three tabs 100 px wide with a 4 px gap: centres at 50, 154, 258.
const slots = [
  { left: 0, width: 100 },
  { left: 104, width: 100 },
  { left: 208, width: 100 },
];
const drag = (from: number, offset: number): DragState => ({
  id: "x",
  from,
  to: landingIndex(slots, from, offset),
  offset,
  slots,
  gap: 4,
});

describe("tab drop geometry", () => {
  test("a tab lands past every neighbour whose centre its own centre has crossed", () => {
    expect([0, 103, 105, 209].map((offset) => landingIndex(slots, 0, offset))).toEqual([0, 0, 1, 2]);
    expect([0, -103, -105, -209].map((offset) => landingIndex(slots, 2, offset))).toEqual([2, 2, 1, 0]);
  });

  test("neighbours between the slot and the landing place slide one tab width toward the gap; others stay", () => {
    const right = drag(0, 209);
    expect([1, 2].map((index) => shiftOf(right, index))).toEqual([-104, -104]);
    const left = drag(2, -105);
    expect([0, 1].map((index) => shiftOf(left, index))).toEqual([0, 104]);
  });

  test("the landing gap and the caret sit where the tab will be", () => {
    expect([landingLeft(drag(0, 209)), caretLeft(drag(0, 209))]).toEqual([208, 310]);
    expect([landingLeft(drag(2, -105)), caretLeft(drag(2, -105))]).toEqual([104, 102]);
    expect([landingLeft(drag(1, 0)), caretLeft(drag(1, 0))]).toEqual([104, 102]);
  });

  test("clampOffset keeps the dragged tab within the first-to-last slot span", () => {
    expect(clampOffset(slots, 0, -50)).toBe(0);
    expect(clampOffset(slots, 0, 500)).toBe(208);
    expect(clampOffset(slots, 2, -500)).toBe(-208);
    expect(clampOffset(slots, 2, 50)).toBe(0);
    expect(clampOffset(slots, 1, -500)).toBe(-104);
    expect(clampOffset(slots, 1, 500)).toBe(104);
    expect(clampOffset([{ left: 4, width: 180 }], 0, 200)).toBe(0);
  });
});
