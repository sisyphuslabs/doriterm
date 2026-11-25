import { describe, expect, test } from "bun:test";
import { DEFAULT_RATIO, clampRatio, focusPair, splitBeside } from "./split-focus.ts";

describe("the two panes split focus shows", () => {
  test("a two-pane tab shows both, in the tab's order, whichever has the focus", () => {
    expect(focusPair(["a", "b"], "a", null)).toEqual(["a", "b"]);
    expect(focusPair(["a", "b"], "b", null)).toEqual(["a", "b"]);
  });

  test("past two panes it shows the focused one and the one seen before it, in the tab's order", () => {
    expect(focusPair(["a", "b", "c", "d"], "d", "b")).toEqual(["b", "d"]);
    expect(focusPair(["a", "b", "c", "d"], "a", "c")).toEqual(["a", "c"]);
  });

  test("with none seen before (or that one gone, or the same), the focused pane and its neighbour", () => {
    expect(focusPair(["a", "b", "c"], "b", null)).toEqual(["b", "c"]);
    expect(focusPair(["a", "b", "c"], "c", "gone")).toEqual(["b", "c"]);
    expect(focusPair(["a", "b", "c"], "a", "a")).toEqual(["a", "b"]);
  });

  test("one pane, or a focus outside the tab, is no split", () => {
    expect(focusPair(["a"], "a", null)).toBeNull();
    expect(focusPair(["a", "b"], "x", null)).toBeNull();
  });
});

describe("the split's ratio", () => {
  test("starts at 55:45 and stays within 30:70 to 70:30", () => {
    expect(DEFAULT_RATIO).toBe(0.55);
    expect([clampRatio(0.1), clampRatio(0.5), clampRatio(0.95)]).toEqual([0.3, 0.5, 0.7]);
  });

  test("a stored value that is not a number is the default", () => {
    expect(clampRatio(Number.NaN)).toBe(DEFAULT_RATIO);
  });
});

describe("split focus orientation", () => {
  test("stacked top and bottom in portrait, side by side in landscape", () => {
    expect(splitBeside(390, 700)).toBe(false);
    expect(splitBeside(800, 330)).toBe(true);
    expect(splitBeside(500, 500)).toBe(false);
  });
});
