import { describe, expect, test } from "bun:test";
import { type ListDragState, rowCaretTop, rowLandingIndex, rowLandingTop, rowShiftOf } from "./list-drop-geometry.ts";

// Three 28 px rows with a 1 px gap under a 28 px header: centres at 42, 71, 100.
const slots = [
  { top: 28, height: 28 },
  { top: 57, height: 28 },
  { top: 86, height: 28 },
];
const drag = (from: number, offset: number): ListDragState => ({
  id: "x",
  from,
  to: rowLandingIndex(slots, from, offset),
  offset,
  slots,
  gap: 1,
});

describe("row drop geometry", () => {
  test("a row lands past every neighbour whose centre its own centre has crossed", () => {
    expect([0, 28, 30, 59].map((offset) => rowLandingIndex(slots, 0, offset))).toEqual([0, 0, 1, 2]);
    expect([0, -28, -30, -59].map((offset) => rowLandingIndex(slots, 2, offset))).toEqual([2, 2, 1, 0]);
  });

  test("rows between the slot and the landing place slide one row height toward the gap; others stay", () => {
    const down = drag(0, 59);
    expect([1, 2].map((index) => rowShiftOf(down, index))).toEqual([-29, -29]);
    const up = drag(2, -30);
    expect([0, 1].map((index) => rowShiftOf(up, index))).toEqual([0, 29]);
  });

  test("the landing wash and the reduced-motion caret sit where the row will be", () => {
    expect([rowLandingTop(drag(0, 59)), rowCaretTop(drag(0, 59))]).toEqual([86, 114.5]);
    expect([rowLandingTop(drag(2, -30)), rowCaretTop(drag(2, -30))]).toEqual([57, 56.5]);
  });
});
