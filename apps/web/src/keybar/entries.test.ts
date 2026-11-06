import { expect, test } from "bun:test";
import { activeEntries, packEntries, packName, specialEntries } from "./entries.ts";
import { addPack, addFavorite, removeKey } from "./operations.ts";
import { defaultSettings } from "./settings.ts";

test("the bar draws the person's keys in their own order, with the bytes each one sends", () => {
  const settings = { ...defaultSettings(), keys: ["esc", "ctrl", "left"] };
  expect(specialEntries(settings, "other")).toEqual([
    { id: "esc", label: "esc", name: "Escape", icon: null, bytes: "\u001b" },
    { id: "ctrl", label: "ctrl", name: "Control", icon: null, bytes: null },
    { id: "left", label: "←", name: "Arrow left", icon: "left", bytes: "\u001b[D" },
  ]);
});

test("the command key is left out where the terminal's host is not a Mac", () => {
  const settings = defaultSettings();
  expect(specialEntries(settings, "mac").map((entry) => entry.id)).toContain("cmd");
  expect(specialEntries(settings, "other").map((entry) => entry.id)).not.toContain("cmd");
});

test("a key the settings no longer hold draws nothing", () => {
  expect(specialEntries(removeKey(defaultSettings(), "esc"), "other").map((entry) => entry.id)).not.toContain("esc");
});

test("an active pack's keys come from the pack, and Favorites from the person's own keys", () => {
  const pack = addPack(defaultSettings(), "navigation");
  expect(activeEntries(pack).map((entry) => entry.id)).toContain("nav-home");
  expect(activeEntries(pack).find((entry) => entry.id === "nav-home")?.bytes).toBe("\u001b[H");
  expect(activeEntries({ ...pack, activePack: null })).toEqual([]);

  const added = addFavorite(defaultSettings(), { id: "k1", label: "Interrupt", input: "Ctrl+C" });
  if (added.kind !== "added") throw new Error(added.reason);
  expect(activeEntries({ ...added.settings, activePack: "favorites" })).toEqual([
    { id: "k1", label: "Interrupt", name: "Interrupt", icon: null, bytes: "\u0003" },
  ]);
});

test("a pack names itself, and a tab nobody knows reads as its own id", () => {
  expect(packName("tmux")).toBe("Tmux");
  expect(packName("favorites")).toBe("Favorites");
  expect(packName("nope")).toBe("nope");
  expect(packEntries(defaultSettings(), "nope")).toEqual([]);
});
