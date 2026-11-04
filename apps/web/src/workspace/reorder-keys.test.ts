import { describe, expect, test } from "bun:test";
import { reorderKeys, reorderStep } from "./reorder-keys.ts";

const press = (code: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
  code,
  metaKey: mods.meta === true,
  ctrlKey: mods.ctrl === true,
  shiftKey: mods.shift === true,
  altKey: mods.alt === true,
});

describe("the keys that move a row", () => {
  test("on macOS Cmd+Shift with an arrow moves it, the tab strip's Left/Right included", () => {
    const steps = ["ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"].map((code) =>
      reorderStep(press(code, { meta: true, shift: true }), "mac"),
    );
    expect(steps).toEqual([-1, -1, 1, 1]);
  });

  test("elsewhere Ctrl+Shift+PageUp/PageDown moves it, Ghostty's move_tab chord", () => {
    expect(reorderStep(press("PageUp", { ctrl: true, shift: true }), "other")).toBe(-1);
    expect(reorderStep(press("PageDown", { ctrl: true, shift: true }), "other")).toBe(1);
  });

  test("plain arrows (roving focus) and the other platform's chord do not move it", () => {
    expect(reorderStep(press("ArrowDown"), "mac")).toBeNull();
    expect(reorderStep(press("ArrowDown", { shift: true }), "mac")).toBeNull();
    expect(reorderStep(press("PageDown", { ctrl: true, shift: true }), "mac")).toBeNull();
    expect(reorderStep(press("ArrowDown", { meta: true, shift: true }), "other")).toBeNull();
  });

  test("the menu shows the first chord of each direction", () => {
    expect(reorderKeys("mac")).toEqual({ up: ["⌘", "⇧", "↑"], down: ["⌘", "⇧", "↓"] });
    expect(reorderKeys("other")).toEqual({ up: ["Ctrl", "Shift", "PgUp"], down: ["Ctrl", "Shift", "PgDn"] });
  });
});
