import { describe, expect, test } from "bun:test";
import { defaultKeymap } from "./defaults.ts";
import { triggersFor } from "./keymap.ts";

const spaces = (platform: "mac" | "other"): string[][] =>
  Array.from({ length: 9 }, (_, index) => triggersFor(defaultKeymap(platform), `space.select:${index + 1}`));

describe("the space keys, as herdr-app binds them", () => {
  test("on a Mac Ctrl+1-9 select a space, Cmd+1-9 stay its tabs, and Cmd+Alt+[ / ] cycle the spaces", () => {
    const keymap = defaultKeymap("mac");
    expect(spaces("mac")).toEqual(Array.from({ length: 9 }, (_, index) => [`ctrl+${index + 1}`]));
    expect(triggersFor(keymap, "tab.select:1")).toEqual(["super+1"]);
    expect(triggersFor(keymap, "tab.select:9")).toEqual(["super+9"]);
    expect(triggersFor(keymap, "space.prev")).toEqual(["alt+super+["]);
    expect(triggersFor(keymap, "space.next")).toEqual(["alt+super+]"]);
  });

  test("on Linux and Windows Alt+1-9 select a space, Ctrl+1-9 are its tabs, and Ctrl+Shift+PgUp / PgDn cycle the spaces", () => {
    const keymap = defaultKeymap("other");
    expect(spaces("other")).toEqual(Array.from({ length: 9 }, (_, index) => [`alt+${index + 1}`]));
    expect(triggersFor(keymap, "tab.select:1")).toEqual(["ctrl+1"]);
    expect(triggersFor(keymap, "tab.select:9")).toEqual(["ctrl+9"]);
    expect(triggersFor(keymap, "space.prev")).toEqual(["ctrl+shift+page_up", "ctrl+alt+["]);
    expect(triggersFor(keymap, "space.next")).toEqual(["ctrl+shift+page_down", "ctrl+alt+]"]);
  });

  test("Cmd+Shift+R on a Mac and Ctrl+Shift+R elsewhere rename the tab, beside herdr-app's F2", () => {
    expect(triggersFor(defaultKeymap("mac"), "tab.rename")).toEqual(["f2", "shift+super+r"]);
    expect(triggersFor(defaultKeymap("other"), "tab.rename")).toEqual(["f2", "ctrl+shift+r"]);
  });

  test("no platform binds a number chord to both a tab and a space", () => {
    for (const platform of ["mac", "other"] as const) {
      const keymap = defaultKeymap(platform);
      for (let place = 1; place <= 9; place += 1) {
        const tab = triggersFor(keymap, `tab.select:${place}`);
        const space = triggersFor(keymap, `space.select:${place}`);
        expect(tab.filter((trigger) => space.includes(trigger))).toEqual([]);
      }
    }
  });
});

describe("the answer keys an agent's question UI reads", () => {
  test("no default takes Alt+Up or Alt+Down, so a focused program reads them (#1302)", () => {
    for (const platform of ["mac", "other"] as const) {
      expect(defaultKeymap(platform).get("alt+up")).toBeUndefined();
      expect(defaultKeymap(platform).get("alt+down")).toBeUndefined();
    }
  });

  test("an Alt+arrow a default does bind moves focus or sends the program its own bytes", () => {
    for (const platform of ["mac", "other"] as const) {
      const arrows = [...defaultKeymap(platform)].filter(([trigger]) => /^alt\+(left|right|up|down)$/.test(trigger));
      const taken = arrows.filter(([, action]) => !action.startsWith("pane.go:") && !action.startsWith("send:"));
      expect(taken).toEqual([]);
    }
  });
});
