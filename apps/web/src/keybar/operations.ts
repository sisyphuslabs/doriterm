import { DEFAULT_KEY_IDS, SPECIAL_KEYS, specialKey } from "./catalog.ts";
import { parseKeyInput } from "./custom.ts";
import { type CustomKey, type KeyBarSettings, KEYBAR_VERSION } from "./settings.ts";
import { FAVORITES_PACK_ID, isPackId } from "./packs.ts";

/** Every change here is a pure function of the previous document, so a stored value is never mutated in place. */

function move<T>(items: readonly T[], from: number, to: number): readonly T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return items;
  next.splice(to, 0, moved);
  return next;
}

function indexOf(items: readonly string[], id: string): number {
  return items.indexOf(id);
}

/** Moves one special key to a new place in the bar's row. */
export function moveKey(settings: KeyBarSettings, id: string, to: number): KeyBarSettings {
  const keys = move(settings.keys, indexOf(settings.keys, id), to);
  return keys === settings.keys ? settings : { ...settings, keys };
}

export function removeKey(settings: KeyBarSettings, id: string): KeyBarSettings {
  if (!settings.keys.includes(id)) return settings;
  return { ...settings, keys: settings.keys.filter((entry) => entry !== id) };
}

/**
 * Where a key sits in the bar's default row. A restored key lands between the same neighbours a person saw before it
 * went away; one the default row does not carry joins after those it does, in the order the list offers it.
 */
const rowRank = (entry: string): number => {
  const inRow = DEFAULT_KEY_IDS.indexOf(entry);
  return inRow === -1 ? DEFAULT_KEY_IDS.length + SPECIAL_KEYS.findIndex((one) => one.id === entry) : inRow;
};

/**
 * Puts a removed key back where the bar's own row has it, so restoring two keys puts them back in the order a person
 * sees rather than in the order they were restored.
 */
export function restoreKey(settings: KeyBarSettings, id: string): KeyBarSettings {
  if (settings.keys.includes(id) || specialKey(id) === undefined) return settings;
  const before = settings.keys.filter((entry) => rowRank(entry) < rowRank(id)).length;
  const keys = [...settings.keys];
  keys.splice(before, 0, id);
  return { ...settings, keys };
}

export function movePack(settings: KeyBarSettings, id: string, to: number): KeyBarSettings {
  const packs = move(settings.packs, indexOf(settings.packs, id), to);
  return packs === settings.packs ? settings : { ...settings, packs };
}

/** Turns a pack's tab on. The first pack added becomes the one the bar shows, so adding a pack shows something. */
export function addPack(settings: KeyBarSettings, id: string): KeyBarSettings {
  if (!isPackId(id) || settings.packs.includes(id)) return settings;
  return { ...settings, packs: [...settings.packs, id], activePack: settings.activePack ?? id };
}

export function removePack(settings: KeyBarSettings, id: string): KeyBarSettings {
  if (!settings.packs.includes(id)) return settings;
  const packs = settings.packs.filter((entry) => entry !== id);
  return { ...settings, packs, activePack: settings.activePack === id ? null : settings.activePack };
}

/** Shows one pack's keys in the bar, or the special keys alone when the id is null or no longer a tab. */
export function setActivePack(settings: KeyBarSettings, id: string | null): KeyBarSettings {
  const activePack = id !== null && settings.packs.includes(id) ? id : null;
  return settings.activePack === activePack ? settings : { ...settings, activePack };
}

export type FavoriteResult =
  | { readonly kind: "added"; readonly settings: KeyBarSettings; readonly key: CustomKey }
  | { readonly kind: "error"; readonly reason: string };

/**
 * Adds a key to Favorites from what the person typed. A refused entry changes nothing: the settings keep the keys they
 * had, and the caller shows the reason beside the field.
 */
export function addFavorite(
  settings: KeyBarSettings,
  entry: { readonly id: string; readonly label: string; readonly input: string },
): FavoriteResult {
  const label = entry.label.trim();
  if (label === "") return { kind: "error", reason: "Give the key a label, e.g. Interrupt." };
  const parsed = parseKeyInput(entry.input);
  if (parsed.kind === "error") return { kind: "error", reason: parsed.reason };
  if (settings.favorites.some((key) => key.id === entry.id)) {
    return { kind: "error", reason: "That key is already in Favorites." };
  }
  const key: CustomKey = { id: entry.id, label, input: entry.input.trim(), bytes: parsed.key.bytes };
  const packs = settings.packs.includes(FAVORITES_PACK_ID) ? settings.packs : [...settings.packs, FAVORITES_PACK_ID];
  // The bar shows Favorites after the add, so the new key is where the person can see it.
  return {
    kind: "added",
    key,
    settings: {
      ...settings,
      favorites: [...settings.favorites, key],
      packs,
      activePack: FAVORITES_PACK_ID,
    },
  };
}

export function removeFavorite(settings: KeyBarSettings, id: string): KeyBarSettings {
  if (!settings.favorites.some((key) => key.id === id)) return settings;
  return { ...settings, favorites: settings.favorites.filter((key) => key.id !== id) };
}

export function renameFavorite(settings: KeyBarSettings, id: string, label: string): KeyBarSettings {
  const trimmed = label.trim();
  const current = settings.favorites.find((key) => key.id === id);
  if (trimmed === "" || current === undefined || current.label === trimmed) return settings;
  return {
    ...settings,
    favorites: settings.favorites.map((key) => (key.id === id ? { ...key, label: trimmed } : key)),
  };
}

export function moveFavorite(settings: KeyBarSettings, id: string, to: number): KeyBarSettings {
  const favorites = move(
    settings.favorites,
    settings.favorites.findIndex((key) => key.id === id),
    to,
  );
  return favorites === settings.favorites ? settings : { ...settings, favorites };
}

/** Resets the bar's own keys to the ones a new device starts with, leaving packs and Favorites alone. */
export function resetKeys(settings: KeyBarSettings): KeyBarSettings {
  const same =
    settings.keys.length === DEFAULT_KEY_IDS.length &&
    settings.keys.every((id, index) => DEFAULT_KEY_IDS[index] === id);
  return same ? settings : { ...settings, keys: DEFAULT_KEY_IDS };
}

export { KEYBAR_VERSION };
