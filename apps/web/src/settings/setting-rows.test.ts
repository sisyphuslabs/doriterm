import { describe, expect, test } from "bun:test";
import { SECTIONS } from "./settings-sections.tsx";
import { matchSections } from "./settings-search.ts";
import { matchSettings } from "./setting-rows.ts";

const titles = (query: string) => matchSettings(query).map((hit) => `${hit.section}: ${hit.title}`);

describe("searching for one setting (#1528)", () => {
  test("a query lists the matching settings themselves, each with its section", () => {
    expect(titles("cursor")).toContain("terminal: cursor-style");
    expect(titles("text size")).toContain("appearance: Text size");
    expect(titles("awake")).toEqual(["device: Keep the screen awake"]);
  });

  test("a Ghostty key is found by its description as well as its name, and lands on its own row", () => {
    const hit = matchSettings("cursor").find((each) => each.title === "cursor-style");
    expect(hit?.anchor).toBe("terminal-cursor-style");
    expect(hit?.detail).not.toBe("");
  });

  test("Copy on selection is found by its label and its Ghostty config key", () => {
    const hit = matchSettings("copy on selection").find((each) => each.title === "Copy on selection");
    expect(hit?.anchor).toBe("terminal-copy-on-select");
    expect(titles("copy-on-select")).toContain("terminal: Copy on selection");
  });

  test("a row's own words find it: keybinds finds the keybinding import (#1472)", () => {
    expect(titles("keybinds")).toContain("keybindings: Import keybinds…");
    expect(titles("theme")).toContain("appearance: Appearance");
  });

  test("direct finds no setting: the direct path is off and nothing offers it (#2070)", () => {
    expect(matchSettings("direct")).toEqual([]);
    expect(matchSections(SECTIONS, "direct")).toEqual([]);
  });

  test("an empty query or one nothing holds lists no setting", () => {
    expect(matchSettings("")).toEqual([]);
    expect(matchSettings("   ")).toEqual([]);
    expect(matchSettings("zzz")).toEqual([]);
  });

  test("a section holding a matching setting is listed too, from the same words (#1472)", () => {
    expect(matchSections(SECTIONS, "keybinds").map((section) => section.id)).toEqual(["keybindings"]);
    expect(matchSections(SECTIONS, "cursor-style").map((section) => section.id)).toEqual(["terminal"]);
  });
});
