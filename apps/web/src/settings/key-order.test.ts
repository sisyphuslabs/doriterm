import { expect, test } from "bun:test";
import { defaultSettings, type KeyBarSettings } from "../keybar/settings.ts";
import { inVisibleOrder } from "./key-order.ts";

const withKeys = (keys: readonly string[]): KeyBarSettings => ({ ...defaultSettings(), keys });

test("the visible keys take the slots they already hold", () => {
  const settings = withKeys(["ctrl", "esc", "shift"]);
  expect(inVisibleOrder(settings, ["esc", "ctrl", "shift"]).keys).toEqual(["esc", "ctrl", "shift"]);
});

test("a hidden key keeps its slot, so a visible move is exactly one place", () => {
  // A host without Command hides it: the stored list still holds it, and it must not be moved or skipped over.
  const settings = withKeys(["ctrl", "cmd", "shift", "esc"]);
  expect(inVisibleOrder(settings, ["ctrl", "esc", "shift"]).keys).toEqual(["ctrl", "cmd", "esc", "shift"]);
});

test("an order that names no stored key changes nothing", () => {
  const settings = withKeys(["ctrl", "shift"]);
  expect(inVisibleOrder(settings, []).keys).toEqual(["ctrl", "shift"]);
});
