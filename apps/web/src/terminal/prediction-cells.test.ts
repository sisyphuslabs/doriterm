import { describe, expect, test } from "bun:test";
import { drawnCells, type PredictedCell, type OverlayScreen, placeCells } from "./prediction-cells.ts";

const GA = "\u{AC00}";

/** A screen of `cols` x `rows` with the cursor at `cursor` and the given cells written, keyed "row,col". */
function screen(
  cursor: { readonly row: number; readonly col: number },
  written: Record<string, { readonly text: string; readonly width?: number }> = {},
  { cols = 20, rows = 6, alt = false, visible = true } = {},
): OverlayScreen {
  return {
    getCols: () => cols,
    getRows: () => rows,
    getCursor: () => ({ ...cursor, visible }),
    usingAltScreen: () => alt,
    getCell: (row, col) => {
      const cell = written[`${row},${col}`];
      if (cell === undefined) return { char: 0, width: 1 };
      const chars = [...cell.text];
      return chars.length > 1
        ? { char: cell.text.codePointAt(0) ?? 0, chars: cell.text, width: cell.width ?? 1 }
        : { char: cell.text.codePointAt(0) ?? 0, width: cell.width ?? 1 };
    },
  };
}

const at = (row: number, col: number, text: string, width: 1 | 2 = 1): PredictedCell => ({ row, col, text, width });

// A row 17.328125 px high and cells 8.4 px wide, from a grid whose first active row starts at (4.5, 10.25) in the
// scroller: the fractional sizes a 3x screen lays out.
const GRID = { left: 4.5, top: 10.25, cell: 8.4, row: 17.328125, cols: 20 };

describe("placeCells", () => {
  test("a narrow cell at row 3, column 7 is one cell wide at that cell's box, with the cursor after it", () => {
    const placed = placeCells([at(3, 7, "l")], GRID, true);
    expect(placed.cells).toHaveLength(1);
    const [cell] = placed.cells;
    expect(cell?.text).toBe("l");
    expect(cell?.wide).toBe(false);
    expect(cell?.left).toBeCloseTo(4.5 + 7 * 8.4, 9);
    expect(cell?.top).toBeCloseTo(10.25 + 3 * 17.328125, 9);
    expect(cell?.width).toBeCloseTo(8.4, 9);
    expect(placed.cursor?.left).toBeCloseTo(4.5 + 8 * 8.4, 9);
    expect(placed.cursor?.top).toBeCloseTo(cell?.top ?? Number.NaN, 9);
  });

  test("a wide cell covers two cells and moves the cursor two", () => {
    const placed = placeCells([at(3, 7, GA, 2)], GRID, true);
    expect(placed.cells[0]).toMatchObject({ text: GA, wide: true });
    expect(placed.cells[0]?.width).toBeCloseTo(2 * 8.4, 9);
    expect(placed.cursor?.left).toBeCloseTo(4.5 + 9 * 8.4, 9);
  });

  test("a run of four is four adjacent cells, the cursor after the last", () => {
    const run = [..."ls -"].map((text, index) => at(2, 2 + index, text));
    const placed = placeCells(run, GRID, true);
    expect(placed.cells.map((cell) => cell.text)).toEqual(["l", "s", " ", "-"]);
    placed.cells.forEach((cell, index) => {
      expect(cell.left).toBeCloseTo(4.5 + (2 + index) * 8.4, 9);
      expect(cell.top).toBeCloseTo(10.25 + 2 * 17.328125, 9);
    });
    expect(placed.cursor?.left).toBeCloseTo(4.5 + 6 * 8.4, 9);
  });

  test("a cell ending on the last column leaves the cursor on that column, as a pending wrap does", () => {
    const placed = placeCells([at(1, 18, GA, 2)], GRID, true);
    expect(placed.cursor?.left).toBeCloseTo(4.5 + 19 * 8.4, 9);
  });

  test("no cursor is drawn when the program hides its own", () => {
    expect(placeCells([at(1, 2, "l")], GRID, false).cursor).toBeNull();
  });
});

describe("drawnCells validates predictions against the terminal's own cells and cursor", () => {
  test("a prediction the screen does not show yet is drawn", () => {
    expect(drawnCells([at(3, 7, "l")], screen({ row: 3, col: 7 }))).toEqual([at(3, 7, "l")]);
  });

  test("a prediction the echo already shows is not drawn over it", () => {
    const echoed = screen({ row: 3, col: 8 }, { "3,7": { text: "l" } });
    expect(drawnCells([at(3, 7, "l"), at(3, 8, "s")], echoed)).toEqual([at(3, 8, "s")]);
  });

  test("a wide prediction is shown by the screen only as a wide cell with its text", () => {
    const wide = screen({ row: 3, col: 9 }, { "3,7": { text: GA, width: 2 } });
    expect(drawnCells([at(3, 7, GA, 2)], wide)).toEqual([]);
    const narrowSame = screen({ row: 3, col: 9 }, { "3,7": { text: GA, width: 1 } });
    expect(drawnCells([at(3, 7, GA, 2)], narrowSame)).toEqual([at(3, 7, GA, 2)]);
  });

  test("a grapheme of several codepoints is compared whole", () => {
    const flag = "e\u0301";
    const shown = screen({ row: 0, col: 1 }, { "0,0": { text: flag } });
    expect(drawnCells([at(0, 0, flag)], shown)).toEqual([]);
  });

  test("a different character under a prediction does not confirm it", () => {
    const other = screen({ row: 3, col: 8 }, { "3,7": { text: "x" } });
    expect(drawnCells([at(3, 7, "l")], other)).toEqual([at(3, 7, "l")]);
  });

  test("predictions off the cursor's row are not drawn: the cursor has left the row they were made on", () => {
    expect(drawnCells([at(3, 7, "l")], screen({ row: 4, col: 0 }))).toEqual([]);
  });

  test("a cell past the grid, or a wide cell that does not fit the row, is not drawn", () => {
    const edge = screen({ row: 2, col: 19 });
    expect(drawnCells([at(2, 19, GA, 2)], edge)).toEqual([]);
    expect(drawnCells([at(2, 20, "l")], edge)).toEqual([]);
    expect(drawnCells([at(2, -1, "l")], edge)).toEqual([]);
    expect(drawnCells([at(6, 0, "l")], screen({ row: 6, col: 0 }))).toEqual([]);
  });

  test("nothing is drawn on the alternate screen", () => {
    expect(drawnCells([at(3, 7, "l")], screen({ row: 3, col: 7 }, {}, { alt: true }))).toEqual([]);
  });
});
