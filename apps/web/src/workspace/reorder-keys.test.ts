import { describe, expect, test } from "bun:test";
import { NO_OVERRIDES, resolveKeymap } from "../keys/keymap.ts";
import type { Platform } from "../keys/trigger.ts";
import { reorderKeys, reorderStep } from "./reorder-keys.ts";

const press = (code: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
  code,
  metaKey: mods.meta === true,
  ctrlKey: mods.ctrl === true,
  shiftKey: mods.shift === true,
  altKey: mods.alt === true,
});

const defaults = (platform: Platform) => resolveKeymap(platform, NO_OVERRIDES);

describe("the keys that move a row", () => {
  test("on macOS Cmd+Shift with an arrow moves it, the tab strip's Left/Right included", () => {
    const steps = ["ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"].map((code) =>
      reorderStep(press(code, { meta: true, shift: true }), "mac", defaults("mac")),
    );
    expect(steps).toEqual([-1, -1, 1, 1]);
  });

  test("elsewhere Ctrl+Alt+Shift+PageUp/PageDown moves it; Ctrl+Shift+PageUp/PageDown are herdr-app's space keys", () => {
    expect(reorderStep(press("PageUp", { ctrl: true, alt: true, shift: true }), "other", defaults("other"))).toBe(-1);
    expect(reorderStep(press("PageDown", { ctrl: true, alt: true, shift: true }), "other", defaults("other"))).toBe(1);
    expect(reorderStep(press("PageDown", { ctrl: true, shift: true }), "other", defaults("other"))).toBeNull();
  });

  test("plain arrows (roving focus) and the other platform's chord do not move it", () => {
    expect(reorderStep(press("ArrowDown"), "mac", defaults("mac"))).toBeNull();
    expect(reorderStep(press("ArrowDown", { shift: true }), "mac", defaults("mac"))).toBeNull();
    expect(reorderStep(press("PageDown", { ctrl: true, alt: true, shift: true }), "mac", defaults("mac"))).toBeNull();
    expect(reorderStep(press("ArrowDown", { meta: true, shift: true }), "other", defaults("other"))).toBeNull();
  });

  test("a rebound Move tab left/right moves the row with the new chord, and the replaced default no longer does (#205)", () => {
    const keymap = resolveKeymap(
      "other",
      new Map([
        ["ctrl+alt+j", "tab.move:right"],
        ["ctrl+alt+shift+page_down", null],
      ]),
    );
    expect(reorderStep(press("KeyJ", { ctrl: true, alt: true }), "other", keymap)).toBe(1);
    expect(reorderStep(press("PageDown", { ctrl: true, alt: true, shift: true }), "other", keymap)).toBeNull();
    expect(reorderStep(press("PageUp", { ctrl: true, alt: true, shift: true }), "other", keymap)).toBe(-1);
  });

  test("the menu shows the first chord of each direction, a rebound one included", () => {
    expect(reorderKeys("mac", defaults("mac"))).toEqual({ up: ["⌘", "⇧", "↑"], down: ["⌘", "⇧", "↓"] });
    expect(reorderKeys("other", defaults("other"))).toEqual({
      up: ["Ctrl", "Alt", "Shift", "PgUp"],
      down: ["Ctrl", "Alt", "Shift", "PgDn"],
    });
    const rebound = resolveKeymap(
      "other",
      new Map([
        ["ctrl+alt+j", "tab.move:right"],
        ["ctrl+alt+shift+page_down", null],
      ]),
    );
    expect(reorderKeys("other", rebound).down).toEqual(["Ctrl", "Alt", "J"]);
  });
});
