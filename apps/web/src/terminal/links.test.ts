import { describe, expect, test } from "bun:test";
import { type CellSource, linkAt, openableLink, showsOtherTarget, urlsIn } from "./links.ts";

describe("openableLink", () => {
  test("http, https and mailto open, as the exact href", () => {
    expect(openableLink("https://example.com/a b")).toBe("https://example.com/a%20b");
    expect(openableLink("http://example.com")).toBe("http://example.com/");
    expect(openableLink("mailto:someone@example.com")).toBe("mailto:someone@example.com");
  });

  test("every other scheme, a broken target and a link with credentials never open", () => {
    for (const target of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<p>x",
      "vscode://open",
      "ssh://host",
      "not a url",
      "",
      "https://user:pass@example.com",
    ]) {
      expect(openableLink(target)).toBeNull();
    }
  });
});

describe("urlsIn", () => {
  test("finds plain URLs and leaves prose punctuation and unopened closers out", () => {
    expect(urlsIn("see https://example.com/x. and http://a.test/b, then").map(({ url }) => url)).toEqual([
      "https://example.com/x",
      "http://a.test/b",
    ]);
    expect(urlsIn("(https://example.com/wiki/A_(b)) end").map(({ url }) => url)).toEqual([
      "https://example.com/wiki/A_(b)",
    ]);
    expect(urlsIn('"https://example.com/q?x=1" <mailto:me@example.com>').map(({ url }) => url)).toEqual([
      "https://example.com/q?x=1",
      "mailto:me@example.com",
    ]);
  });

  test("a bare scheme is not a link, and the span covers exactly the URL", () => {
    expect(urlsIn("https:// and mailto:")).toEqual([]);
    expect(urlsIn("go https://e.com now")).toEqual([{ start: 3, end: 16, url: "https://e.com" }]);
  });
});

/** A core holding `rows` of text on a screen `cols` wide (no scrollback), where `wraps[i]` means row i wraps on. */
function screen(
  rows: readonly string[],
  cols: number,
  wraps: readonly boolean[] = [],
  links: Record<string, string> = {},
) {
  const core: CellSource = {
    getScrollbackCount: () => 0,
    getRows: () => rows.length,
    getCols: () => cols,
    getCell: (row, col) => {
      const char = rows[row]?.[col] ?? " ";
      const uri = links[`${row}:${col}`];
      return { char: char.codePointAt(0) ?? 32, ...(uri === undefined ? {} : { linkUri: uri }) };
    },
    getScrollbackCell: () => ({ char: 32 }),
    getScrollbackLineLen: () => 0,
    getRowMetadata: (row) => ({ wrapsToNext: wraps[row] ?? false, continuesPrevious: wraps[row - 1] ?? false }),
  };
  return core;
}

describe("linkAt", () => {
  test.each([
    ["\u754c", ""],
    ["\u754c", "x"],
    ["\u{1f680}", ""],
    ["\u{1f680}", "x"],
  ])("a link ending in %s after %s underlines both cells of the wide glyph", (glyph, prefix) => {
    const target = "https://example.com/";
    const core: CellSource = {
      ...screen([""], prefix.length + 2),
      getCell: (_row, col) => {
        if (col < prefix.length) return { char: 120, width: 1, linkUri: target };
        if (col === prefix.length) return { char: glyph.codePointAt(0) ?? 32, width: 2, linkUri: target };
        return { char: 0, width: 0 };
      },
    };
    expect(linkAt(core, { row: 0, col: prefix.length })?.runs).toEqual([{ row: 0, start: 0, end: prefix.length + 2 }]);
  });

  test("a plain URL is found from any of its cells and opens whole", () => {
    const core = screen(["open https://example.com/a now"], 40);
    const link = linkAt(core, { row: 0, col: 10 });
    expect(link?.href).toBe("https://example.com/a");
    expect(link?.runs).toEqual([{ row: 0, start: 5, end: 26 }]);
    expect(linkAt(core, { row: 0, col: 2 })).toBeNull();
  });

  test("a URL wrapped over rows is one link, opened whole from either row", () => {
    const core = screen(["x https://exa", "mple.com/long", " tail"], 13, [true, false]);
    for (const at of [
      { row: 0, col: 4 },
      { row: 1, col: 3 },
    ]) {
      const link = linkAt(core, at);
      expect(link?.href).toBe("https://example.com/long");
      expect(link?.runs).toEqual([
        { row: 0, start: 2, end: 13 },
        { row: 1, start: 0, end: 13 },
      ]);
    }
  });

  test("an OSC 8 link opens its own target, and says when its text is not that target", () => {
    const cells = Object.fromEntries([3, 4, 5, 6].map((col) => [`0:${col}`, "https://real.example/x"]));
    const core = screen(["go docs here"], 20, [], cells);
    const link = linkAt(core, { row: 0, col: 4 });
    expect(link).toEqual({
      href: "https://real.example/x",
      target: "https://real.example/x",
      text: "docs",
      runs: [{ row: 0, start: 3, end: 7 }],
    });
    expect(link === null ? null : showsOtherTarget(link)).toBe(true);
  });

  test("an OSC 8 link to a scheme that does not open is found, but has nothing to open", () => {
    const cells = Object.fromEntries([0, 1, 2, 3].map((col) => [`0:${col}`, "javascript:alert(1)"]));
    const link = linkAt(screen(["here"], 10, [], cells), { row: 0, col: 1 });
    expect(link?.href).toBeNull();
    expect(link?.target).toBe("javascript:alert(1)");
  });

  test("a plain URL whose text is its target shows no other target", () => {
    const link = linkAt(screen(["https://e.com"], 20), { row: 0, col: 0 });
    expect(link === null ? null : showsOtherTarget(link)).toBe(false);
  });
});
