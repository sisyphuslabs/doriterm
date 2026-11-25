import { describe, expect, test } from "bun:test";
import { loadSidebarPrefs, pruneFolded, SIDEBAR_KEY } from "./sidebar-prefs.ts";

const stored = (value: string | null) => ({ getItem: (key: string) => (key === SIDEBAR_KEY ? value : null) });

describe("loadSidebarPrefs: folded (#2746)", () => {
  test("the folded agents round-trip, entries that are not addresses dropped", () => {
    const saved = JSON.stringify({
      sort: "space",
      colors: {},
      collapsed: ["local"],
      folded: ["t1", 7, "box/t3", null],
    });
    expect(loadSidebarPrefs(stored(saved))).toEqual({
      sort: "space",
      colors: {},
      collapsed: ["local"],
      folded: ["t1", "box/t3"],
    });
  });

  test("prefs saved before folds existed, bad JSON and nothing saved all read as nothing folded", () => {
    expect(loadSidebarPrefs(stored(JSON.stringify({ sort: "status" }))).folded).toEqual([]);
    expect(loadSidebarPrefs(stored("{not json")).folded).toEqual([]);
    expect(loadSidebarPrefs(stored(null)).folded).toEqual([]);
    expect(loadSidebarPrefs(stored(JSON.stringify({ folded: "t1" }))).folded).toEqual([]);
  });
});

describe("pruneFolded", () => {
  const folded = ["t1", "box/t3"];

  test("nothing is dropped before the terminals have loaded", () => {
    expect(pruneFolded(folded, new Set(), false)).toBe(folded);
  });

  test("once loaded, a fold of an agent that is gone is dropped", () => {
    expect(pruneFolded(folded, new Set(["t1", "t2"]), true)).toEqual(["t1"]);
  });

  test("while every folded agent is listed the saved list is the same one, so it is not written again", () => {
    expect(pruneFolded(folded, new Set(["t1", "box/t3"]), true)).toBe(folded);
  });
});
