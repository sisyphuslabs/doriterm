import { expect, test } from "bun:test";
import { DEFAULT_KEY_IDS } from "./catalog.ts";
import {
  addFavorite,
  addPack,
  moveFavorite,
  moveKey,
  movePack,
  removeFavorite,
  removeKey,
  removePack,
  renameFavorite,
  resetKeys,
  restoreKey,
  setActivePack,
} from "./operations.ts";
import { defaultSettings, KEYBAR_VERSION, reviveSettings, type KeyBarSettings } from "./settings.ts";

const custom = (id: string, label = "Interrupt", input = "Ctrl+C") => ({
  id,
  label,
  input,
  bytes: "\u0003",
});

const withFavorites = (settings: KeyBarSettings, ...ids: readonly string[]): KeyBarSettings => ({
  ...settings,
  favorites: ids.map((id) => custom(id)),
  packs: ["favorites"],
  activePack: "favorites",
});

test("a new device starts with today's row and no pack tabs", () => {
  expect(defaultSettings()).toEqual({
    version: KEYBAR_VERSION,
    keys: DEFAULT_KEY_IDS,
    packs: [],
    activePack: null,
    favorites: [],
  });
});

test("nothing stored reads as the defaults", () => {
  expect(reviveSettings(undefined)).toEqual(defaultSettings());
  expect(reviveSettings("nope")).toEqual(defaultSettings());
  expect(reviveSettings({ version: 99, keys: ["esc"] })).toEqual(defaultSettings());
});

test("a stored bar survives a reload, and an empty one stays empty", () => {
  const stored = { version: 1, keys: ["esc", "tab"], packs: ["tmux"], activePack: "tmux", favorites: [] };
  expect(reviveSettings(stored)).toEqual({
    version: 1,
    keys: ["esc", "tab"],
    packs: ["tmux"],
    activePack: "tmux",
    favorites: [],
  });
  expect(reviveSettings({ version: 1, keys: [], packs: [] }).keys).toEqual([]);
});

test("an unreadable entry is dropped rather than trusted", () => {
  const revived = reviveSettings({
    version: 1,
    keys: ["esc", "esc", "not-a-key", 7],
    packs: ["tmux", "tmux", "nope"],
    activePack: "nope",
    favorites: [
      { id: "a", label: "Interrupt", input: "Ctrl+C", bytes: "\u0003" },
      { id: "", label: "x", input: "x", bytes: "x" },
      { id: "b", label: "  ", input: "x", bytes: "x" },
      { id: "c", label: "x", input: "x", bytes: "" },
      { id: "d", label: "x", input: "x", bytes: "y".repeat(500) },
      "nope",
    ],
  });
  expect(revived.keys).toEqual(["esc"]);
  expect(revived.packs).toEqual(["tmux"]);
  expect(revived.activePack).toBeNull();
  expect(revived.favorites).toEqual([{ id: "a", label: "Interrupt", input: "Ctrl+C", bytes: "\u0003" }]);
});

test("a key moves to a new place and the rest keep their order", () => {
  const settings = defaultSettings();
  const moved = moveKey(settings, "esc", 0);
  expect(moved.keys.slice(0, 2)).toEqual(["esc", "ctrl"]);
  expect(moved.keys).toHaveLength(settings.keys.length);
  expect(moveKey(settings, "esc", 99)).toBe(settings);
  expect(moveKey(settings, "not-a-key", 0)).toBe(settings);
});

test("removing a key takes it out, and restoring it puts it back where the list places it", () => {
  const settings = defaultSettings();
  const removed = removeKey(settings, "tab");
  expect(removed.keys).not.toContain("tab");
  expect(removeKey(removed, "tab")).toBe(removed);
  const restored = restoreKey(removed, "tab");
  expect(restored.keys).toEqual(settings.keys);
  expect(restoreKey(restored, "tab")).toBe(restored);
  expect(restoreKey(settings, "not-a-key")).toBe(settings);
});

test("packs are added as tabs, moved, and removed with the bar falling back to the special keys", () => {
  const settings = defaultSettings();
  const added = addPack(addPack(settings, "navigation"), "tmux");
  expect(added.packs).toEqual(["navigation", "tmux"]);
  expect(added.activePack).toBe("navigation");
  expect(addPack(added, "navigation")).toBe(added);
  expect(addPack(added, "nope")).toBe(added);
  const moved = movePack(added, "tmux", 0);
  expect(moved.packs).toEqual(["tmux", "navigation"]);
  const removed = removePack(moved, "tmux");
  expect(removed.packs).toEqual(["navigation"]);
  expect(removed.activePack).toBe("navigation");
  const emptied = removePack(removed, "navigation");
  expect(emptied.packs).toEqual([]);
  expect(removePack(emptied, "navigation")).toBe(emptied);
});

test("the bar shows one pack's keys, and only a pack that is a tab", () => {
  const added = addPack(defaultSettings(), "tmux");
  // A pack that is not a tab has nothing to show, so the bar falls back to the special keys.
  expect(setActivePack(added, "navigation").activePack).toBeNull();
  expect(setActivePack(added, null).activePack).toBeNull();
  expect(setActivePack(addPack(added, "navigation"), "navigation").activePack).toBe("navigation");
});

test("a custom key is stored with the bytes it sends, and adding it turns Favorites into a tab", () => {
  const added = addFavorite(defaultSettings(), { id: "k1", label: " Interrupt ", input: " Ctrl+C " });
  if (added.kind !== "added") throw new Error(added.reason);
  expect(added.key).toEqual({ id: "k1", label: "Interrupt", input: "Ctrl+C", bytes: "\u0003" });
  expect(added.settings.favorites).toEqual([added.key]);
  expect(added.settings.packs).toEqual(["favorites"]);
  expect(added.settings.activePack).toBe("favorites");
});

test("adding a key shows Favorites even when another pack was the one the bar drew", () => {
  const onTmux = addPack(defaultSettings(), "tmux");
  expect(onTmux.activePack).toBe("tmux");
  const added = addFavorite(onTmux, { id: "k2", label: "Interrupt", input: "^C" });
  if (added.kind !== "added") throw new Error(added.reason);
  expect(added.settings.activePack).toBe("favorites");
  expect(added.settings.packs).toEqual(["tmux", "favorites"]);
});

test("a refused custom key changes nothing and says why", () => {
  const settings = defaultSettings();
  const noLabel = addFavorite(settings, { id: "k1", label: " ", input: "Ctrl+C" });
  expect(noLabel).toEqual({ kind: "error", reason: "Give the key a label, e.g. Interrupt." });
  const noKey = addFavorite(settings, { id: "k1", label: "Interrupt", input: "Ctrl+" });
  expect(noKey.kind).toBe("error");
  const first = addFavorite(settings, { id: "k1", label: "Interrupt", input: "Ctrl+C" });
  if (first.kind !== "added") throw new Error(first.reason);
  const duplicate = addFavorite(first.settings, { id: "k1", label: "Again", input: "Ctrl+X" });
  expect(duplicate).toEqual({ kind: "error", reason: "That key is already in Favorites." });
});

test("Favorites reorder, rename and remove", () => {
  const settings = withFavorites(defaultSettings(), "a", "b", "c");
  expect(moveFavorite(settings, "c", 0).favorites.map((key) => key.id)).toEqual(["c", "a", "b"]);
  expect(renameFavorite(settings, "b", " Interrupt ").favorites[1]?.label).toBe("Interrupt");
  expect(renameFavorite(settings, "b", "  ")).toBe(settings);
  expect(removeFavorite(settings, "b").favorites.map((key) => key.id)).toEqual(["a", "c"]);
  expect(removeFavorite(settings, "nope")).toBe(settings);
});

test("resetting the keys leaves packs and Favorites alone", () => {
  const settings = withFavorites(removeKey(defaultSettings(), "esc"), "a");
  const reset = resetKeys(settings);
  expect(reset.keys).toEqual(DEFAULT_KEY_IDS);
  expect(reset.favorites).toHaveLength(1);
  expect(reset.packs).toEqual(["favorites"]);
});
