import type { HostPlatform } from "../terminal/keys.ts";

/** A glyph the bar draws in place of a label, for the four arrows. */
export type BarIcon = "left" | "right" | "up" | "down";

/**
 * One key the person can put in the phone's keys bar. The bytes it sends live in the terminal's own map
 * (`terminal/keys.ts`), so a key here and a key the bar sends can never disagree; a modifier sends nothing and latches
 * the next key instead.
 */
export interface SpecialKey {
  readonly id: string;
  readonly label: string;
  /** Spoken name, e.g. "Escape". */
  readonly name: string;
  /** The glyph drawn in place of the label, or null to draw the label. */
  readonly icon: BarIcon | null;
  /** A key only a Mac host's terminal understands, hidden where the host is not one. */
  readonly macOnly: boolean;
}

const key = (id: string, label: string, name: string, icon: BarIcon | null = null, macOnly = false): SpecialKey => ({
  id,
  label,
  name,
  icon,
  macOnly,
});

/**
 * Everything the person can add to the bar, in the order the settings list offers them: the modifiers, the editing
 * keys, the arrows, then the characters a phone keyboard makes awkward. The four characters behind the bar's old swipe
 * are ordinary keys here, so a person who wants them first can have them first.
 */
export const SPECIAL_KEYS: readonly SpecialKey[] = [
  key("ctrl", "ctrl", "Control"),
  key("cmd", "cmd", "Command", null, true),
  key("shift", "shift", "Shift"),
  key("alt", "alt", "Option"),
  key("tab", "tab", "Tab"),
  key("esc", "esc", "Escape"),
  key("interrupt", "^C", "Control C"),
  key("enter", "⏎", "Enter"),
  key("backspace", "⌫", "Backspace"),
  key("clear", "clear", "Clear screen"),
  key("left", "←", "Arrow left", "left"),
  key("up", "↑", "Arrow up", "up"),
  key("down", "↓", "Arrow down", "down"),
  key("right", "→", "Arrow right", "right"),
  key("home", "home", "Home"),
  key("end", "end", "End"),
  key("pageup", "pgup", "Page up"),
  key("pagedown", "pgdn", "Page down"),
  key("delete", "del", "Delete"),
  key("tilde", "~", "Tilde"),
  key("pipe", "|", "Vertical bar"),
  key("slash", "/", "Slash"),
  key("dash", "-", "Hyphen"),
];

const BY_ID: ReadonlyMap<string, SpecialKey> = new Map(SPECIAL_KEYS.map((entry) => [entry.id, entry]));

export function specialKey(id: string): SpecialKey | undefined {
  return BY_ID.get(id);
}

/** The keys this host's bar can show: a Mac-only key is offered where the terminal's host is a Mac. */
export function specialKeysOn(host: HostPlatform): readonly SpecialKey[] {
  return host === "mac" ? SPECIAL_KEYS : SPECIAL_KEYS.filter((entry) => !entry.macOnly);
}

/**
 * The keys the bar carries before the person changes anything: Control, Shift, Tab and Escape first, as the owner's row
 * has them (#2604), then Command, the other modifiers through ^C and Enter (#1551), then the characters that used to sit
 * behind a swipe (#195, #667). The arrows are not among them: the arrow pad's button opens them over the row.
 */
export const DEFAULT_KEY_IDS: readonly string[] = [
  "ctrl",
  "shift",
  "tab",
  "esc",
  "cmd",
  "alt",
  "interrupt",
  "enter",
  "tilde",
  "pipe",
  "slash",
  "dash",
];
