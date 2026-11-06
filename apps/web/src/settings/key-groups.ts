import type { HostPlatform } from "../terminal/keys.ts";
import { specialKeysOn, type SpecialKey } from "../keybar/catalog.ts";

/** The picker's groups, in the order the sheet draws them. */
export type KeyGroup = "modifiers" | "navigation" | "symbols";

export const GROUP_TITLE: Readonly<Record<KeyGroup, string>> = {
  modifiers: "Modifiers",
  navigation: "Navigation",
  symbols: "Symbols",
};

const OF: Readonly<Record<string, KeyGroup>> = {
  ctrl: "modifiers",
  cmd: "modifiers",
  shift: "modifiers",
  alt: "modifiers",
  tab: "navigation",
  esc: "navigation",
  interrupt: "navigation",
  enter: "navigation",
  backspace: "navigation",
  clear: "navigation",
  left: "navigation",
  up: "navigation",
  down: "navigation",
  right: "navigation",
  home: "navigation",
  end: "navigation",
  pageup: "navigation",
  pagedown: "navigation",
  delete: "navigation",
  tilde: "symbols",
  pipe: "symbols",
  slash: "symbols",
  dash: "symbols",
};

export interface GroupedKeys {
  readonly group: KeyGroup;
  readonly keys: readonly SpecialKey[];
}

/** The catalog this host shows, in picker groups: modifiers, then the keys that move, then the characters. */
export function groupedKeys(host: HostPlatform): readonly GroupedKeys[] {
  const groups: readonly KeyGroup[] = ["modifiers", "navigation", "symbols"];
  const keys = specialKeysOn(host);
  return groups.map((group) => ({ group, keys: keys.filter((entry) => OF[entry.id] === group) }));
}
