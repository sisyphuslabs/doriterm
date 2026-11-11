import { describe, expect, test } from "bun:test";
import { defaultKeymap } from "./defaults.ts";
import { triggersFor } from "./keymap.ts";
import { GHOSTTY_DEFAULTS } from "./ghostty-defaults.ts";
import { HERDR_APP_MAC, HERDR_APP_OTHER } from "./herdr-app-defaults.ts";
import { PLATFORM_RESERVED, TAKEN_ON_PURPOSE } from "./platform-reserved.ts";

/**
 * Actions whose keys doriface picks itself on that platform; their triggers must be free in both upstream keymaps, and
 * in the OS and browsers. Off macOS resize and equalize are doriface's: Ghostty's take Super, which Windows and GNOME
 * keep for themselves.
 */
const DORIFACE_ONLY: Readonly<Record<"mac" | "other", readonly string[]>> = {
  // Ghostty binds move_tab by default only on Linux and Windows; there doriface takes the same chord.
  mac: ["layout.focus:sidebar", "layout.filter:sidebar", "tab.move:left", "tab.move:right"],
  other: [
    "layout.focus:sidebar",
    "layout.filter:sidebar",
    // herdr-app cycles spaces with Ghostty's move_tab chord here, so moving a tab takes a chord of doriface's own.
    "tab.move:left",
    "tab.move:right",
    "pane.resize:left",
    "pane.resize:right",
    "pane.resize:up",
    "pane.resize:down",
    "pane.equalize",
  ],
};

describe("doriface-only bindings", () => {
  test.each([
    ["mac", HERDR_APP_MAC],
    ["other", HERDR_APP_OTHER],
  ] as const)("on %s they take no trigger that herdr-app or Ghostty binds by default", (platform, herdr) => {
    const taken = new Set([...GHOSTTY_DEFAULTS, ...herdr]);
    const triggers = DORIFACE_ONLY[platform].flatMap((action) => triggersFor(defaultKeymap(platform), action));
    expect(triggers.length).toBeGreaterThan(0);
    expect(triggers.filter((trigger) => taken.has(trigger))).toEqual([]);
  });

  test.each(["mac", "other"] as const)("on %s they take no chord the OS or a browser reserves", (platform) => {
    const triggers = DORIFACE_ONLY[platform].flatMap((action) => triggersFor(defaultKeymap(platform), action));
    expect(triggers.filter((trigger) => trigger in PLATFORM_RESERVED)).toEqual([]);
  });

  test.each(["mac", "other"] as const)(
    "on %s a default takes a reserved chord only where TAKEN_ON_PURPOSE says why",
    (platform) => {
      const taken = [...defaultKeymap(platform).keys()].filter((trigger) => trigger in PLATFORM_RESERVED);
      expect(taken.filter((trigger) => !(trigger in TAKEN_ON_PURPOSE))).toEqual([]);
      expect(taken.length).toBeGreaterThan(0);
    },
  );

  test("every chord taken on purpose is a reserved one", () => {
    expect(Object.keys(TAKEN_ON_PURPOSE).filter((trigger) => !(trigger in PLATFORM_RESERVED))).toEqual([]);
  });

  // The reverse check (#824): a chord kept here that no default binds any more is a claim about a binding that is gone,
  // so a rebinding that frees the chord must remove the entry with it.
  test("every chord taken on purpose is bound by a default on mac or other", () => {
    const bound = new Set([...defaultKeymap("mac").keys(), ...defaultKeymap("other").keys()]);
    expect(Object.keys(TAKEN_ON_PURPOSE).filter((trigger) => !bound.has(trigger))).toEqual([]);
  });

  test("on Linux and Windows moving a tab takes Ctrl+Alt+Shift+PgUp / PgDn, since herdr-app's spaces take Ctrl+Shift", () => {
    const keymap = defaultKeymap("other");
    expect([triggersFor(keymap, "tab.move:left"), triggersFor(keymap, "tab.move:right")]).toEqual([
      ["ctrl+alt+shift+page_up"],
      ["ctrl+alt+shift+page_down"],
    ]);
  });
});

describe("the vendored Ghostty table", () => {
  test("includes the bindings whose modifier Ghostty computes per platform (ctrlOrSuper and its mods variables)", () => {
    const computed = ["shift+super+p", "ctrl+shift+p", "super+,", "ctrl+,", "super+enter", "ctrl+enter"];
    const variables = ["super+c", "ctrl+shift+c", "super+v", "ctrl+shift+v", "super+=", "ctrl+="];
    const listed = new Set(GHOSTTY_DEFAULTS);
    expect([...computed, ...variables].filter((trigger) => !listed.has(trigger))).toEqual([]);
  });
});
