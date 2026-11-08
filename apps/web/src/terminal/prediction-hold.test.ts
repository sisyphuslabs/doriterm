import { describe, expect, test } from "bun:test";
import type { OverlayScreen, PredictedCell } from "./prediction-cells.ts";
import { paintedCells, predictedCursor } from "./prediction-hold.ts";

const at = (row: number, col: number, text: string, width: 1 | 2 = 1): PredictedCell => ({ row, col, text, width });

function screen(written: Record<string, string>, cols = 20): OverlayScreen {
  return {
    getCols: () => cols,
    getRows: () => 6,
    getCursor: () => ({ row: 2, col: 0, visible: true }),
    usingAltScreen: () => false,
    getCell: (row, col) => ({ char: written[`${row},${col}`]?.codePointAt(0) ?? 0, width: 1 }),
  };
}

describe("paintedCells: a confirmed cell leaves the layer only once the renderer has painted its glyph", () => {
  test("a cell no longer wanted while the terminal holds a glyph there stays painted until the render", () => {
    const echoed = screen({ "2,4": "a" });
    expect(paintedCells([at(2, 5, "b")], [at(2, 4, "a")], echoed, false)).toEqual([at(2, 4, "a"), at(2, 5, "b")]);
  });

  test("once the renderer has painted, the confirmed cell goes and the unconfirmed tail stays", () => {
    const echoed = screen({ "2,4": "a" });
    expect(paintedCells([at(2, 5, "b")], [at(2, 4, "a"), at(2, 5, "b")], echoed, true)).toEqual([at(2, 5, "b")]);
  });

  test("a cell dropped over a blank terminal cell (killed, nothing echoed) goes at once", () => {
    expect(paintedCells([], [at(2, 4, "a")], screen({}), false)).toEqual([]);
    expect(paintedCells([], [at(2, 4, "a")], screen({ "2,4": " " }), false)).toEqual([]);
  });

  test("a held cell gives way to a wanted cell over any of its columns", () => {
    const echoed = screen({ "2,4": "x", "2,5": "x" });
    expect(paintedCells([at(2, 5, "c")], [at(2, 4, "\u{AC00}", 2)], echoed, false)).toEqual([at(2, 5, "c")]);
  });

  test("additions are painted in the same call, in column order", () => {
    expect(paintedCells([at(2, 4, "a"), at(2, 5, "b")], [], screen({}), false)).toEqual([at(2, 4, "a"), at(2, 5, "b")]);
  });
});

describe("predictedCursor: where a composition and the next key go while predictions are painted", () => {
  test("the cell after the last painted cell, a wide one counting two", () => {
    expect(predictedCursor([at(2, 4, "a"), at(2, 5, "\u{AC00}", 2)], 20)).toEqual({ row: 2, col: 7 });
  });

  test("kept on the last column, as a pending wrap keeps the real cursor", () => {
    expect(predictedCursor([at(2, 18, "\u{AC00}", 2)], 20)).toEqual({ row: 2, col: 19 });
  });

  test("none while nothing is painted: the real cursor is where things go", () => {
    expect(predictedCursor([], 20)).toBeNull();
  });
});
