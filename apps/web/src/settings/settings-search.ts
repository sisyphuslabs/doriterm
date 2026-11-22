import { matchSettings } from "./setting-rows.ts";
import type { SectionId } from "./settings-sections.tsx";

/**
 * What each section holds, in the words its groups, rows and own searches use (#1460). A section's name always counts
 * as well, so it is not repeated here. Keep a section's words next to its rows when they change.
 */
const SECTION_WORDS: Readonly<Record<SectionId, readonly string[]>> = {
  device: [
    "host",
    "this device",
    "pair a device",
    "paired devices",
    "revoke",
    "add to home screen",
    "install",
    "keep the screen awake",
    "keep running in the background",
    "dock",
    "menu bar",
    "getting started",
    "advanced connection",
    "connect through",
    "relay",
    "loopback",
  ],
  machines: [
    "mesh",
    "members",
    "join requests",
    "approval",
    "approve",
    "revoke",
    "remove",
    "online",
    "offline",
    "connect a machine",
    "pair",
    "invite",
    "join",
    "phone",
    "command",
    "qr",
  ],
  terminal: ["font", "font size", "cursor", "scrollback", "ghostty", "config", "colors", "padding", "opacity", "bell"],
  keyboard: ["key bar", "keys bar", "your keys", "packs", "extra keys", "phone keys", "ctrl chords"],
  notifications: ["alerts", "push", "test notification", "following"],
  appearance: ["theme", "dark", "light", "night", "day", "density", "text size", "font size", "herdr-app theme"],
  keybindings: ["shortcuts", "shortcut", "bindings", "import keybindings"],
  voice: ["dictation", "dictate", "speech recognition", "microphone", "language"],
};

/**
 * The sections whose name, words or settings (setting-rows.ts, #1528) hold the query, case-insensitive, in list order;
 * an empty query keeps them all.
 */
export function matchSections<T extends { readonly id: SectionId; readonly label: string }>(
  sections: readonly T[],
  query: string,
): readonly T[] {
  const wanted = query.trim().toLowerCase();
  if (wanted === "") return sections;
  const holding = new Set(matchSettings(wanted).map((hit) => hit.section));
  return sections.filter(
    (section) =>
      section.label.toLowerCase().includes(wanted) ||
      SECTION_WORDS[section.id].some((word) => word.includes(wanted)) ||
      holding.has(section.id),
  );
}
