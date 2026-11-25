import type { WTerm } from "@wterm/react";

/**
 * The text on a terminal's screen, read from its core rather than the page: with WebGL drawing the rows are pixels,
 * not DOM text (#2810). One line per row, wide continuation cells skipped, trailing blanks kept.
 */
export function screenText(term: WTerm): string {
  const core = term.bridge;
  if (core === null) return "";
  const lines: string[] = [];
  for (let row = 0; row < core.getRows(); row += 1) {
    let line = "";
    for (let col = 0; col < core.getCols(); col += 1) {
      const cell = core.getCell(row, col);
      if (cell.width === 0) continue;
      line += cell.chars ?? (cell.char === 0 ? " " : String.fromCodePoint(cell.char));
    }
    lines.push(line);
  }
  return lines.join("\n");
}
