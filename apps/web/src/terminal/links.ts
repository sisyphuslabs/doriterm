/**
 * Links in terminal output, as Ghostty and herdr-app open them: OSC 8 hyperlinks (a cell carries its target) and plain
 * URLs in the text, either one possibly wrapped over several rows. Only http, https and mailto ever open.
 */

const OPENABLE = new Set(["http:", "https:", "mailto:"]);

/** The exact href a link opens, or null for any other scheme (javascript:, file:, data:, custom) or a broken target. */
export function openableLink(target: string): string | null {
  const url = URL.parse(target.trim());
  if (url === null || !OPENABLE.has(url.protocol)) return null;
  // Credentials in a link are a way to make one host read as another.
  if (url.username !== "" || url.password !== "") return null;
  return url.href;
}

/** Plain URLs as a terminal recognises them: a scheme, then everything up to whitespace or a quote or bracket. */
const PLAIN_URL = /\b(?:https?:\/\/|mailto:)[^\s<>"'`]+/gu;
const CLOSERS: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };

/** Prose punctuation after a URL is not part of it, nor a closing bracket the URL never opened. */
function trimEnd(url: string): string {
  let end = url.length;
  for (;;) {
    const last = url[end - 1] ?? "";
    if (".,;:!?".includes(last) && last !== "") {
      end -= 1;
      continue;
    }
    const opener = CLOSERS[last];
    if (opener !== undefined) {
      const body = url.slice(0, end - 1);
      if (body.split(opener).length - 1 < body.split(last).length) {
        end -= 1;
        continue;
      }
    }
    return url.slice(0, end);
  }
}

export interface TextSpan {
  readonly start: number;
  readonly end: number;
  readonly url: string;
}

/** Every plain URL in `text`, with its span: the text a link shows is its own target. */
export function urlsIn(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  for (const match of text.matchAll(PLAIN_URL)) {
    const url = trimEnd(match[0]);
    if (url.length > "mailto:".length) spans.push({ start: match.index, end: match.index + url.length, url });
  }
  return spans;
}

/** One terminal cell, by absolute row (0 is the oldest row kept) and column. */
export interface CellAt {
  readonly row: number;
  readonly col: number;
}

/** The part of a link on one row: columns `start` up to `end`, exclusive. */
export interface LinkRun {
  readonly row: number;
  readonly start: number;
  readonly end: number;
}

export interface TerminalLink {
  /** What it opens; null when the scheme is not one that opens (it is still shown, never opened). */
  readonly href: string | null;
  /** The target as the program gave it. */
  readonly target: string;
  /** The text on screen. For an OSC 8 link it may differ from the target, and then the target is shown first. */
  readonly text: string;
  readonly runs: readonly LinkRun[];
}

/** What reading the cells needs from the terminal core (wterm's TerminalCore). */
export interface CellSource {
  getScrollbackCount(): number;
  getRows(): number;
  getCols(): number;
  getCell(row: number, col: number): CellInfo;
  getScrollbackCell(offset: number, col: number): CellInfo;
  getScrollbackLineLen(offset: number): number;
  getRowMetadata?(row: number): RowWrap | null;
  getScrollbackRowMetadata?(offset: number): RowWrap | null;
}

interface CellInfo {
  readonly char: number;
  readonly chars?: string;
  readonly width?: number;
  readonly spacerHead?: boolean;
  readonly linkUri?: string;
}

interface RowWrap {
  readonly wrapsToNext: boolean;
  readonly continuesPrevious: boolean;
}

/** One row's cells as the core holds them, scrollback first (row 0 is the oldest kept). */
function rowOf(core: CellSource, row: number) {
  const history = core.getScrollbackCount();
  const total = history + core.getRows();
  if (row < 0 || row >= total) return null;
  if (row < history) {
    const offset = history - 1 - row;
    return {
      cols: core.getScrollbackLineLen(offset),
      cell: (col: number) => core.getScrollbackCell(offset, col),
      wrap: core.getScrollbackRowMetadata?.(offset) ?? null,
    };
  }
  return {
    cols: core.getCols(),
    cell: (col: number) => core.getCell(row - history, col),
    wrap: core.getRowMetadata?.(row - history) ?? null,
  };
}

/** One logical line, wrapped rows joined: its text and the cell each character (code point) came from. */
export interface Line {
  readonly text: string;
  readonly cells: readonly (CellAt & { readonly uri: string | undefined })[];
}

export function lineAround(core: CellSource, row: number): Line | null {
  if (rowOf(core, row) === null) return null;
  let first = row;
  for (;;) {
    const above = rowOf(core, first - 1);
    const here = rowOf(core, first);
    if (above === null || here === null || !above.wrap?.wrapsToNext || here.wrap?.continuesPrevious === false) break;
    first -= 1;
  }
  let text = "";
  const cells: (CellAt & { readonly uri: string | undefined })[] = [];
  for (let at = first; ; at += 1) {
    const current = rowOf(core, at);
    if (current === null) break;
    for (let col = 0; col < current.cols; col += 1) {
      const cell = current.cell(col);
      if (cell.width === 0 || cell.spacerHead === true) continue;
      const chars = cell.chars ?? String.fromCodePoint(cell.char || 32);
      for (const unit of chars) {
        text += unit;
        cells.push({ row: at, col, uri: cell.linkUri });
      }
    }
    if (!current.wrap?.wrapsToNext) break;
  }
  return { text, cells };
}

/** The cells from index `start` to `end` (exclusive) of a line, as one run per row. */
export function runsOf(line: Line, start: number, end: number): LinkRun[] {
  const runs: LinkRun[] = [];
  for (const cell of line.cells.slice(start, end)) {
    const last = runs.at(-1);
    if (last !== undefined && last.row === cell.row) runs[runs.length - 1] = { ...last, end: cell.col + 1 };
    else runs.push({ row: cell.row, start: cell.col, end: cell.col + 1 });
  }
  return runs;
}

/** The link at a cell: its OSC 8 hyperlink when it has one, else a plain URL its line shows there; null otherwise. */
export function linkAt(core: CellSource, at: CellAt): TerminalLink | null {
  const line = lineAround(core, at.row);
  if (line === null) return null;
  const index = line.cells.findIndex((cell) => cell.row === at.row && cell.col === at.col);
  if (index === -1) return null;
  const uri = line.cells[index]?.uri;
  if (uri !== undefined && uri !== "") {
    let start = index;
    while (start > 0 && line.cells[start - 1]?.uri === uri) start -= 1;
    let end = index + 1;
    while (end < line.cells.length && line.cells[end]?.uri === uri) end += 1;
    return {
      href: openableLink(uri),
      target: uri,
      text: line.text.slice(start, end).trim(),
      runs: runsOf(line, start, end),
    };
  }
  const span = urlsIn(line.text).find(({ start, end }) => index >= start && index < end);
  if (span === undefined) return null;
  return { href: openableLink(span.url), target: span.url, text: span.url, runs: runsOf(line, span.start, span.end) };
}

/** An OSC 8 link whose text is not its own target: the target is shown before it opens. */
export const showsOtherTarget = (link: TerminalLink): boolean => link.text !== link.target;
