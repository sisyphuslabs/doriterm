import { describe, expect, test } from "bun:test";
import { SECTIONS } from "./settings-sections.tsx";
import { matchSections } from "./settings-search.ts";

const found = (query: string) => matchSections(SECTIONS, query).map((section) => section.id);

describe("searching across settings (#1460)", () => {
  test.each([
    ["theme", ["appearance"]],
    ["font", ["terminal", "appearance"]],
    ["relay", ["device"]],
    ["shortcut", ["keybindings"]],
    ["push", ["notifications"]],
    ["dictation", ["voice"]],
    ["invite", ["pair"]],
    ["approval", ["machines"]],
    ["pair a device", ["device"]],
    ["revoke", ["device", "machines"]],
    ["chords", ["keyboard"]],
  ] as const)("%s finds the sections that hold it, in list order", (query, ids) => {
    expect(found(query)).toEqual([...ids]);
  });

  test("a section's own name finds it, whatever the case and the spaces around it", () => {
    expect(found("  KEYBOARD ")).toEqual(["keyboard"]);
    expect(found("connect a machine")).toEqual(["pair"]);
  });

  test("an empty query lists every section; one nothing holds lists none", () => {
    expect(found("")).toEqual(SECTIONS.map((section) => section.id));
    expect(found("   ")).toEqual(SECTIONS.map((section) => section.id));
    expect(found("zzz")).toEqual([]);
  });
});
