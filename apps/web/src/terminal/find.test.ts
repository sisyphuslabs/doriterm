import { describe, expect, test } from "bun:test";
import { findMatches, MatchCache, matchAtOrBefore, stepMatch } from "./find.ts";
import type { CellSource } from "./links.ts";

/** A core with `history` rows of scrollback (oldest first) above a `screen`, `cols` wide; `wraps` holds row numbers that wrap on. */
function core(history: readonly string[], screen: readonly string[], cols: number, wraps: readonly number[] = []) {
  const all = [...history, ...screen];
  const meta = (row: number) => ({ wrapsToNext: wraps.includes(row), continuesPrevious: wraps.includes(row - 1) });
  const cell = (row: number, col: number) => ({ char: all[row]?.codePointAt(col) ?? 32 });
  const source: CellSource = {
    getScrollbackCount: () => history.length,
    getRows: () => screen.length,
    getCols: () => cols,
    getCell: (row, col) => cell(history.length + row, col),
    getScrollbackCell: (offset, col) => cell(history.length - 1 - offset, col),
    getScrollbackLineLen: (offset) => (history[history.length - 1 - offset] ?? "").length,
    getRowMetadata: (row) => meta(history.length + row),
    getScrollbackRowMetadata: (offset) => meta(history.length - 1 - offset),
  };
  return source;
}

describe("findMatches", () => {
  test("finds a line that is only in the scrollback, by absolute row, oldest first", () => {
    const source = core(["needle one", "nothing", "a needle"], ["$ ls", "needle"], 12);
    expect(findMatches(source, "needle").map((match) => match.runs)).toEqual([
      [{ row: 0, start: 0, end: 6 }],
      [{ row: 2, start: 2, end: 8 }],
      [{ row: 4, start: 0, end: 6 }],
    ]);
  });

  test("a match wrapped over two rows is one match with a run on each row", () => {
    const source = core([], ["abc hel", "lo end"], 7, [0]);
    expect(findMatches(source, "hello").map((match) => match.runs)).toEqual([
      [
        { row: 0, start: 4, end: 7 },
        { row: 1, start: 0, end: 2 },
      ],
    ]);
  });

  test.each(["empty", "wide tails", "spacer heads"] as const)(
    "a wrapped line ending in a row of %s is searched once, then the following line is searched",
    (kind) => {
      const base = core(["needle", ""], ["needle"], 6, [0]);
      const source: CellSource = {
        ...base,
        getScrollbackLineLen: (offset) => (offset === 0 && kind !== "empty" ? 6 : base.getScrollbackLineLen(offset)),
        getScrollbackCell: (offset, col) =>
          offset === 0
            ? { char: 0, width: kind === "wide tails" ? 0 : 1, spacerHead: kind === "spacer heads" }
            : base.getScrollbackCell(offset, col),
      };
      expect(findMatches(source, "needle").map((match) => match.runs)).toEqual([
        [{ row: 0, start: 0, end: 6 }],
        [{ row: 2, start: 0, end: 6 }],
      ]);
    },
  );

  test("is case-insensitive unless the query has a capital, and an empty query finds nothing", () => {
    const source = core(["Error here", "error there"], [], 12);
    expect(findMatches(source, "error")).toHaveLength(2);
    expect(findMatches(source, "Error")).toHaveLength(1);
    expect(findMatches(source, "")).toEqual([]);
  });

  test("finds every match in a line, not overlapping", () => {
    expect(findMatches(core([], ["aaaa"], 4), "aa").map((match) => match.runs[0]?.start)).toEqual([0, 2]);
  });
});

describe("stepMatch", () => {
  test("Enter goes to the next match and wraps from the last to the first", () => {
    expect(stepMatch(3, 0, 1)).toBe(1);
    expect(stepMatch(3, 2, 1)).toBe(0);
  });

  test("Shift+Enter goes back and wraps from the first to the last", () => {
    expect(stepMatch(3, 1, -1)).toBe(0);
    expect(stepMatch(3, 0, -1)).toBe(2);
  });

  test("with no current match it starts at an end, and with no matches there is none", () => {
    expect(stepMatch(3, null, 1)).toBe(0);
    expect(stepMatch(3, null, -1)).toBe(2);
    expect(stepMatch(0, null, 1)).toBeNull();
  });
});

describe("matchAtOrBefore", () => {
  test("a new query starts on the last match at or above a row, else the first", () => {
    const matches = findMatches(core(["x", "y x", "z"], ["x"], 4), "x");
    expect(matchAtOrBefore(matches, 2)).toBe(1);
    expect(matchAtOrBefore(matches, 9)).toBe(2);
    expect(matchAtOrBefore(findMatches(core([], ["", "x"], 4), "x"), 0)).toBe(0);
    expect(matchAtOrBefore([], 0)).toBeNull();
  });
});

describe("MatchCache", () => {
  test("scrolling (the same output and query) never searches again; new output or a new query does", () => {
    let searches = 0;
    const search = (query: string) => {
      searches += 1;
      return query === "" ? [] : [{ row: searches, runs: [] }];
    };
    const cache = new MatchCache();
    const first = cache.get(1, "x", search);
    expect(cache.get(1, "x", search)).toBe(first);
    expect(searches).toBe(1);
    cache.get(2, "x", search);
    expect(searches).toBe(2);
    cache.get(2, "xy", search);
    expect(searches).toBe(3);
  });
});
