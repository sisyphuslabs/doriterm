import { KEYS } from "../ghostty/keys.ts";
import type { SectionId } from "./settings-sections.tsx";

/**
 * One setting a search can land on (#1528): the words its row shows, the section that holds it, and how to find the row
 * once that section is drawn: `anchor` is the id of the row's title, else the row is the one whose title reads `title`.
 */
export interface SettingHit {
  readonly section: SectionId;
  readonly title: string;
  readonly detail: string;
  readonly anchor?: string;
  readonly words: readonly string[];
}

const row = (section: SectionId, title: string, detail: string, words: readonly string[] = []): SettingHit => ({
  section,
  title,
  detail,
  words,
});

/** The rows each section draws, in its words. Keep a row here next to the row itself when its title changes. */
const ROWS: readonly SettingHit[] = [
  row("device", "Keep the screen awake", "While a terminal is open", ["screen", "sleep", "wake lock"]),
  row("device", "Show typing before the host echoes it", "Predictive typing on slow links", [
    "predict",
    "local echo",
    "latency",
    "typing",
  ]),
  row("device", "Install Doriterm", "As an app on this device", ["install", "app"]),
  row("device", "Add to Home Screen", "As an app on this phone", ["install", "home screen", "app"]),
  row("device", "Getting started", "The first-run guide", ["guide", "tour"]),
  row("device", "Relay", "The relay this app connects through", ["relay", "self-hosted"]),
  row("device", "Connect through", "Relay or loopback", ["loopback", "route"]),
  row("machines", "Open an invite on your host", "One command on the host", ["invite", "pair", "join"]),
  row("machines", "Join from the other computer", "With the invite", ["join", "pair"]),
  row("machines", "A phone that uses one host only", "Pair a phone", ["phone", "pair", "qr"]),
  row("keyboard", "Keys", "The keys on the phone's key bar", ["key bar", "keys bar", "extra keys", "phone keys"]),
  row("keyboard", "Packs", "Shortcut packs for the key bar", ["packs", "ctrl chords"]),
  row("keyboard", "Your keys", "Keys you made", ["custom keys", "your keys"]),
  row("notifications", "Notifications on this device", "Alerts when an agent needs you", ["alerts", "push"]),
  row("notifications", "Send a test notification", "Check that alerts arrive", ["test", "alerts", "push"]),
  row("appearance", "Text size", "The interface's text size", ["font size", "zoom"]),
  row("appearance", "Appearance", "Theme: dark, light or the system's", ["theme", "dark", "light", "night", "day"]),
  row("appearance", "Density", "How much room the rows take", ["compact", "spacing"]),
  row("appearance", "Import a herdr-app theme", "From a theme file", ["theme", "herdr-app theme", "import"]),
  row("keybindings", "Import keybinds…", "From a Ghostty config", ["keybinds", "keybindings", "import", "ghostty"]),
  row("voice", "Language", "The language dictation listens for", ["dictation", "speech"]),
  row("voice", "Speech recognition", "Where dictation runs", ["dictation", "dictate", "microphone"]),
];

const TERMINAL_ROWS: readonly SettingHit[] = KEYS.map((def) => ({
  section: "terminal",
  title: def.label ?? def.key,
  detail: def.description,
  anchor: `terminal-${def.key}`,
  words: [def.key],
}));

const ALL: readonly SettingHit[] = [...ROWS, ...TERMINAL_ROWS];

const holds = (hit: SettingHit, wanted: string): boolean =>
  hit.title.toLowerCase().includes(wanted) ||
  hit.detail.toLowerCase().includes(wanted) ||
  hit.words.some((word) => word.includes(wanted));

/** The settings whose title, description or words hold the query, case-insensitive; none for an empty query. */
export function matchSettings(query: string): readonly SettingHit[] {
  const wanted = query.trim().toLowerCase();
  return wanted === "" ? [] : ALL.filter((hit) => holds(hit, wanted));
}
