import { describe, expect, test } from "bun:test";
import type { OverlayScreen } from "./prediction-cells.ts";
import { predictorScreen } from "./predictor-screen.ts";

const cursorAt = (row: number, col: number): ReturnType<OverlayScreen["getCursor"]> =>
  // Only row and col are read; the rest of the core's cursor is irrelevant here.
  ({ row, col, visible: true }) as ReturnType<OverlayScreen["getCursor"]>;

function fakeBridge(): OverlayScreen & { cursor: { row: number; col: number }; alt: boolean } {
  const state = {
    cursor: { row: 3, col: 7 },
    alt: false,
    getCols: () => 80,
    getRows: () => 24,
    getCursor: () => cursorAt(state.cursor.row, state.cursor.col),
    getCell: (row: number, col: number) => ({ char: 0x41 + row + col, chars: `c${row}:${col}`, width: (col % 2) + 1 }),
    usingAltScreen: () => state.alt,
  };
  return state;
}

describe("predictorScreen, the predictor's read-only view of wt.bridge", () => {
  test("cols and rows are the bridge's own: rows() is getRows() (the #1439 contract)", () => {
    const bridge = fakeBridge();
    const screen = predictorScreen(bridge);
    expect(screen.cols()).toBe(80);
    expect(screen.rows()).toBe(24);
  });

  test("the cursor is the bridge's row and column, read anew on each call", () => {
    const bridge = fakeBridge();
    const screen = predictorScreen(bridge);
    expect(screen.cursor()).toEqual({ row: 3, col: 7 });
    bridge.cursor = { row: 0, col: 1 };
    expect(screen.cursor()).toEqual({ row: 0, col: 1 });
  });

  test("a cell is the bridge's code point, grapheme and width at that row and column", () => {
    const screen = predictorScreen(fakeBridge());
    expect(screen.cell(2, 5)).toEqual({ char: 0x41 + 7, chars: "c2:5", width: 2 });
    expect(screen.cell(0, 0)).toEqual({ char: 0x41, chars: "c0:0", width: 1 });
  });

  test("altScreen follows the bridge", () => {
    const bridge = fakeBridge();
    const screen = predictorScreen(bridge);
    expect(screen.altScreen()).toBe(false);
    bridge.alt = true;
    expect(screen.altScreen()).toBe(true);
  });
});
