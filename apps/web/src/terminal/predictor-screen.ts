import type { PredictionScreen } from "./prediction.ts";
import type { OverlayScreen } from "./prediction-cells.ts";

/** The predictor's read-only view of the terminal model: `wt.bridge`, method for method. It never writes. */
export function predictorScreen(bridge: OverlayScreen): PredictionScreen {
  return {
    cursor: () => {
      const cursor = bridge.getCursor();
      return { row: cursor.row, col: cursor.col };
    },
    cell: (row, col) => {
      const cell = bridge.getCell(row, col);
      return { char: cell.char, chars: cell.chars, width: cell.width };
    },
    cols: () => bridge.getCols(),
    rows: () => bridge.getRows(),
    altScreen: () => bridge.usingAltScreen(),
  };
}
