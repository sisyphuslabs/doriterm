import type { GhosttyCore } from "@wterm/ghostty";

type CellData = ReturnType<GhosttyCore["getCell"]>;

/**
 * One cell a predictor expects the echo of a typed key to fill (design D1): the overlay's whole input from it. The
 * predictor (plan S4) keeps more per cell (its epoch, when it was sent); this is the part that is drawn.
 */
export interface PredictedCell {
  readonly row: number;
  readonly col: number;
  /** One grapheme. */
  readonly text: string;
  readonly width: 1 | 2;
}

/**
 * What the overlay draws from: the cells to show now, whether to underline them (mosh's flagging: the link is slow or
 * glitching, design D8), and a call whenever that may have changed.
 */
export interface OverlaySource {
  visible(): readonly PredictedCell[];
  underlined?(): boolean;
  subscribe(changed: () => void): () => void;
}

/** The terminal's own state the overlay checks predictions against: the renderer's bridge to libghostty fits it. */
export interface OverlayScreen {
  getCols(): number;
  getRows(): number;
  getCursor(): ReturnType<GhosttyCore["getCursor"]>;
  getCell(row: number, col: number): Pick<CellData, "char" | "chars" | "width">;
  usingAltScreen(): boolean;
  /** A synchronized update (DECSET 2026) is open: the renderer may hold the screen's writes unpainted. */
  synchronizedOutput?(): boolean;
}

/** A cell's text as the terminal holds it: "" for a cell nothing was written to. */
export function cellText(cell: Pick<CellData, "char" | "chars">): string {
  if (cell.chars !== undefined) return cell.chars;
  return cell.char === 0 ? "" : String.fromCodePoint(cell.char);
}

/**
 * The screen already shows the prediction: the echo arrived, and drawing it again would double it. Text AND width must
 * both match; keep the width check when simplifying. An echo of the predicted glyph at another width (a wide prediction
 * the terminal laid out narrow, or the reverse) is a different screen: the cells after it sit one column off from where
 * the predictions after it were placed, so it must not count as confirming this one. A predicted space is never shown
 * by the screen: a blank cell looks the same before its echo as after, so the predictor's own confirmation removes it.
 */
function shown(cell: PredictedCell, screen: OverlayScreen): boolean {
  if (cell.text.trim() === "") return false;
  const real = screen.getCell(cell.row, cell.col);
  return cellText(real) === cell.text && (real.width === 2) === (cell.width === 2);
}

/**
 * The predictions to draw, checked against the terminal itself: only on the main screen, inside the grid, on the row
 * the cursor is on (once it leaves that row the predictions made there are stale), and not where the screen already
 * holds the predicted text. The terminal's cells are only read; a prediction never enters them.
 */
export function drawnCells(cells: readonly PredictedCell[], screen: OverlayScreen): PredictedCell[] {
  if (cells.length === 0 || screen.usingAltScreen()) return [];
  const cols = screen.getCols();
  const rows = screen.getRows();
  const cursor = screen.getCursor();
  return cells.filter(
    (cell) =>
      cell.row === cursor.row &&
      cell.row >= 0 &&
      cell.row < rows &&
      cell.col >= 0 &&
      cell.col + cell.width <= cols &&
      !shown(cell, screen),
  );
}

/** Where the grid's first active cell sits in the scroller, and its cell and row size, in CSS px. */
export interface GridBox {
  readonly left: number;
  readonly top: number;
  readonly cell: number;
  readonly row: number;
  readonly cols: number;
}

export interface PlacedCell {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly text: string;
  readonly wide: boolean;
}

export interface PlacedPrediction {
  readonly cells: readonly PlacedCell[];
  /** The cell after the last prediction, where the cursor will be once the echo arrives; null when none is drawn. */
  readonly cursor: { readonly left: number; readonly top: number } | null;
}

/**
 * Each cell at its column and row, as the renderer lays a row out: `cell` wide per column, `row` high per row, from the
 * first active row's box. The cursor follows the last cell, kept on the last column as a pending wrap keeps it.
 */
export function placeCells(cells: readonly PredictedCell[], grid: GridBox, cursorVisible: boolean): PlacedPrediction {
  const placed = cells.map((cell) => ({
    left: grid.left + cell.col * grid.cell,
    top: grid.top + cell.row * grid.row,
    width: cell.width * grid.cell,
    text: cell.text,
    wide: cell.width === 2,
  }));
  const last = cells.at(-1);
  if (last === undefined || !cursorVisible) return { cells: placed, cursor: null };
  const col = Math.min(last.col + last.width, grid.cols - 1);
  return { cells: placed, cursor: { left: grid.left + col * grid.cell, top: grid.top + last.row * grid.row } };
}
