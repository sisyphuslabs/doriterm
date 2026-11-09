/**
 * Find in a terminal (herdr-app's terminal.search): every match of a query in the screen and the scrollback, read from
 * the core's cells one logical line at a time, so a match a soft wrap splits over two rows is still one match.
 */
import { type CellSource, type LinkRun, lineAround, runsOf } from "./links.ts";

export interface FindMatch {
  /** The match's first row, by absolute row (0 is the oldest row kept). */
  readonly row: number;
  /** Its cells, one run per row it spans. */
  readonly runs: readonly LinkRun[];
}

/** Lower-cases one code point when that keeps it one code point, so indexes stay on the cells they came from. */
const fold = (unit: string): string => {
  const lower = unit.toLowerCase();
  return [...lower].length === 1 ? lower : unit;
};

function indexesOf(haystack: readonly string[], needle: readonly string[]): number[] {
  const found: number[] = [];
  for (let at = 0; at + needle.length <= haystack.length;) {
    if (needle.every((unit, offset) => haystack[at + offset] === unit)) {
      found.push(at);
      at += needle.length;
    } else {
      at += 1;
    }
  }
  return found;
}

/** Every match of `query`, oldest first; case-insensitive unless the query has a capital letter (smart case). */
export function findMatches(core: CellSource, query: string): FindMatch[] {
  if (query === "") return [];
  const sensitive = query !== query.toLowerCase();
  const needle = [...query].map((unit) => (sensitive ? unit : fold(unit)));
  const total = core.getScrollbackCount() + core.getRows();
  const matches: FindMatch[] = [];
  for (let row = 0; row < total;) {
    const line = lineAround(core, row);
    if (line === null) break;
    const units = [...line.text].map((unit) => (sensitive ? unit : fold(unit)));
    for (const start of indexesOf(units, needle)) {
      const runs = runsOf(line, start, start + needle.length);
      const first = runs[0];
      if (first !== undefined) matches.push({ row: first.row, runs });
    }
    row = line.nextRow;
  }
  return matches;
}

/** The match after (`1`) or before (`-1`) `current`, wrapping at either end; from none, the first or the last. */
export function stepMatch(count: number, current: number | null, direction: 1 | -1): number | null {
  if (count === 0) return null;
  if (current === null) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
}

/** Where a new query starts: the last match at or above `row` (the view's bottom), else the first one. */
export function matchAtOrBefore(matches: readonly FindMatch[], row: number): number | null {
  if (matches.length === 0) return null;
  const before = matches.findLastIndex((match) => match.row <= row);
  return before === -1 ? 0 : before;
}

/**
 * The last search, kept until the output or the query changes: a scroll redraws the marks but never reads the
 * scrollback again. `version` counts the output written to the terminal.
 */
export class MatchCache {
  private last: { readonly version: number; readonly query: string; readonly matches: FindMatch[] } | null = null;

  get(version: number, query: string, search: (query: string) => FindMatch[]): FindMatch[] {
    if (this.last?.version === version && this.last.query === query) return this.last.matches;
    const matches = search(query);
    this.last = { version, query, matches };
    return matches;
  }
}
