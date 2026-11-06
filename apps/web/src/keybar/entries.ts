import { keySequence } from "../terminal/keys.ts";
import type { HostPlatform } from "../terminal/keys.ts";
import { type BarIcon, specialKey } from "./catalog.ts";
import { FAVORITES_PACK_ID, pack } from "./packs.ts";
import type { KeyBarSettings } from "./settings.ts";

/**
 * One key as the bar draws it: a built-in key, a pack's key or one of the person's own, resolved to the label it shows
 * and the exact bytes a tap sends.
 */
export interface BarEntry {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly icon: BarIcon | null;
  /** What a tap sends; null for a modifier, which latches the next key instead. */
  readonly bytes: string | null;
}

/** The person's keys, in their order, with the Mac-only key left out where the host is not a Mac. */
export function specialEntries(settings: KeyBarSettings, host: HostPlatform): readonly BarEntry[] {
  return settings.keys.flatMap((id) => {
    const entry = specialKey(id);
    if (entry === undefined || (entry.macOnly && host !== "mac")) return [];
    return [{ id: entry.id, label: entry.label, name: entry.name, icon: entry.icon, bytes: keySequence(id) ?? null }];
  });
}

/** The keys of one pack, or of Favorites; empty where that pack is not one the settings hold. */
export function packEntries(settings: KeyBarSettings, id: string): readonly BarEntry[] {
  if (id === FAVORITES_PACK_ID) {
    return settings.favorites.map((entry) => ({
      id: entry.id,
      label: entry.label,
      name: entry.label,
      icon: null,
      bytes: entry.bytes,
    }));
  }
  const found = pack(id);
  if (found === undefined) return [];
  return found.keys.map((entry) => ({
    id: entry.id,
    label: entry.label,
    name: entry.name,
    icon: null,
    bytes: entry.bytes,
  }));
}

/** The active pack's keys, which the bar draws ahead of the person's own; empty when no pack is active. */
export function activeEntries(settings: KeyBarSettings): readonly BarEntry[] {
  return settings.activePack === null ? [] : packEntries(settings, settings.activePack);
}

export function packName(id: string): string {
  if (id === FAVORITES_PACK_ID) return "Favorites";
  return pack(id)?.name ?? id;
}
