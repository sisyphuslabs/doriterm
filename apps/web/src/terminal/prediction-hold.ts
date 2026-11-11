import { cellText, type OverlayScreen, type PredictedCell } from "./prediction-cells.ts";

const overlaps = (a: PredictedCell, b: PredictedCell): boolean =>
  a.row === b.row && a.col < b.col + b.width && b.col < a.col + a.width;

/** The real cursor has moved past the cell: a write reached it, in typing order. */
const passed = (cursor: { readonly row: number; readonly col: number }, cell: PredictedCell): boolean =>
  cursor.row > cell.row || (cursor.row === cell.row && cursor.col >= cell.col + cell.width);

/**
 * What the layer paints after a change (design review HIGH 4, #1439). The predictor drops a cell at the write that
 * echoes it (mosh's Correct, terminaloverlay.cc:546-549), synchronously inside the pacer's frame, while the renderer
 * paints that write in a later animation frame (wterm.js `_scheduleRender`). Removing the cell at once would leave its
 * column blank for that frame on every keystroke. So a cell no longer wanted stays painted while the terminal holds a
 * glyph there the renderer may not have painted yet, until `rendered` (the grid changed since, or one frame passed); one
 * over a blank terminal cell (killed, nothing echoed) goes at once, and a wanted cell over any of its columns replaces it.
 * A predicted blank (a typed space) leaves the cell blank when echoed, so its cell cannot tell an echo from a kill; the
 * real cursor can: once it has passed the blank, the echo was written, and the blank is held the same way, since dropping
 * it while the cells either side of it are still held or wanted would cut the painted run in two for that frame (#1970).
 * A blank the cursor has not passed (erased before its echo) goes at once, as any killed cell does.
 * Additions are never held back: every wanted cell is painted in the same call.
 */
export function paintedCells(
  wanted: readonly PredictedCell[],
  painted: readonly PredictedCell[],
  screen: OverlayScreen,
  rendered: boolean,
): PredictedCell[] {
  const held = rendered
    ? []
    : painted.filter(
        (cell) =>
          !wanted.some((each) => overlaps(each, cell)) &&
          (cell.text.trim() === ""
            ? passed(screen.getCursor(), cell)
            : cellText(screen.getCell(cell.row, cell.col)).trim() !== ""),
      );
  return [...held, ...wanted].toSorted((a, b) => a.row - b.row || a.col - b.col);
}

/**
 * The predicted cursor: the cell after the last painted one, kept on the last column as a pending wrap keeps the real
 * cursor; null while nothing is painted. A composition is drawn here, not at the real cursor, which lags it by every
 * unconfirmed cell (design review HIGH 3(b)).
 */
export function predictedCursor(
  painted: readonly PredictedCell[],
  cols: number,
): { readonly row: number; readonly col: number } | null {
  const last = painted.at(-1);
  return last === undefined ? null : { row: last.row, col: Math.min(last.col + last.width, cols - 1) };
}
