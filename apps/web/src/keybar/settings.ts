import { DEFAULT_KEY_IDS, SPECIAL_KEYS } from "./catalog.ts";
import { MAX_TEXT_BYTES } from "./custom.ts";
import { isPackId } from "./packs.ts";

export const KEYBAR_VERSION = 1;

/** A key the person defined: the label it shows, what they typed, and the exact bytes it sends. */
export interface CustomKey {
  readonly id: string;
  readonly label: string;
  readonly input: string;
  readonly bytes: string;
}

/**
 * This device's keys bar, versioned and JSON-shaped so a later mesh sync can merge it by id. Nothing here is
 * device-specific except the ids of the person's own keys, so the same document can be compared across devices.
 */
export interface KeyBarSettings {
  readonly version: typeof KEYBAR_VERSION;
  /** The special keys in the bar's row, in the order it draws them. */
  readonly keys: readonly string[];
  /** The packs whose tabs the bar shows, in tab order. */
  readonly packs: readonly string[];
  /** The pack the bar shows, or null for the special keys only. */
  readonly activePack: string | null;
  /** The Favorites pack's keys, in order. */
  readonly favorites: readonly CustomKey[];
}

export function defaultSettings(): KeyBarSettings {
  return { version: KEYBAR_VERSION, keys: DEFAULT_KEY_IDS, packs: [], activePack: null, favorites: [] };
}

const SPECIAL_IDS: ReadonlySet<string> = new Set(SPECIAL_KEYS.map((entry) => entry.id));

function onlyStrings(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function distinct(values: readonly string[], allowed: (value: string) => boolean): readonly string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (!allowed(value) || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null && name in value ? Reflect.get(value, name) : undefined;
}

function customKey(value: unknown): CustomKey | null {
  const id = field(value, "id");
  const label = field(value, "label");
  const input = field(value, "input");
  const bytes = field(value, "bytes");
  if (typeof id !== "string" || id === "") return null;
  if (typeof label !== "string" || label.trim() === "") return null;
  if (typeof input !== "string") return null;
  if (typeof bytes !== "string" || bytes === "" || bytes.length > MAX_TEXT_BYTES) return null;
  return { id, label, input, bytes };
}

/** Two favorites with one id would break removal, renaming and the list's React keys, so a stored duplicate is dropped. */
function distinctFavorites(entries: readonly CustomKey[]): readonly CustomKey[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

/**
 * Reads a stored document. Anything unreadable falls back to the defaults, and a field that is missing takes its
 * default while a field that is present but empty stays empty: a person who removed every key keeps an empty bar.
 */
export function reviveSettings(stored: unknown): KeyBarSettings {
  if (field(stored, "version") !== KEYBAR_VERSION) return defaultSettings();
  const keys = onlyStrings(field(stored, "keys"));
  const packs = onlyStrings(field(stored, "packs"));
  const favorites = field(stored, "favorites");
  const activePack = field(stored, "activePack");
  const kept = packs === null ? [] : distinct(packs, isPackId);
  return {
    version: KEYBAR_VERSION,
    keys: keys === null ? DEFAULT_KEY_IDS : distinct(keys, (id) => SPECIAL_IDS.has(id)),
    packs: kept,
    activePack: typeof activePack === "string" && kept.includes(activePack) ? activePack : null,
    favorites:
      favorites === null || !Array.isArray(favorites)
        ? []
        : distinctFavorites(favorites.map(customKey).filter((entry): entry is CustomKey => entry !== null)),
  };
}
