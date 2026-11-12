import type { Platform } from "./trigger.ts";

/** A herdr-app default that doriface's default keymap does not bind to the same action, and why. */
export interface HerdrDifference {
  /** herdr-app's spelling of the chord, as in its keys file. */
  readonly chord: string;
  /** What doriface's default keymap binds that trigger to; null when nothing. */
  readonly doriface: string | null;
  readonly reason: string;
}

const APP_MENU = "the desktop app's macOS app menu carries it (a standard menu role); a browser keeps it for itself";
const NO_MODS = "Doriterm has no mods, so there is no picker mod to open";
const NO_LAYOUTS = "Doriterm has no layout files to switch between";
const PROGRAM_KEYS =
  "#1302: the program's keys — an agent reads Alt+arrows for its answers and a shell for its word moves";
const CTRL_V_PASTES =
  "Ctrl+V stays the browser's paste, as before: an image on the clipboard reaches the terminal's machine as a file through the paste itself (#742), which needs no clipboard permission (the desktop app grants none), and text is pasted as text where herdr-app sends ^V";

/**
 * Every herdr-app default (herdr-app/keys*.json) that doriface binds differently. `herdr-app-parity.test.ts` holds this
 * table to the vendored files and `defaults.ts` both ways, and `docs/keymap-herdr-app.md` is generated from it.
 */
export const HERDR_APP_DIFFERENCES: Readonly<Record<Platform, readonly HerdrDifference[]>> = {
  mac: [
    { chord: "cmd-q", doriface: null, reason: APP_MENU },
    { chord: "cmd-h", doriface: null, reason: APP_MENU },
    { chord: "cmd-alt-h", doriface: null, reason: APP_MENU },
    { chord: "cmd-shift-l", doriface: null, reason: NO_LAYOUTS },
    { chord: "cmd-p", doriface: null, reason: NO_MODS },
  ],
  other: [
    // #1302: Alt+arrows belong to the program below (answers, word moves, Meta keys), so doriterm binds none of them.
    { chord: "alt-left", doriface: null, reason: PROGRAM_KEYS },
    { chord: "alt-right", doriface: null, reason: PROGRAM_KEYS },
    { chord: "alt-up", doriface: null, reason: PROGRAM_KEYS },
    { chord: "alt-down", doriface: null, reason: PROGRAM_KEYS },
    { chord: "ctrl-shift-k", doriface: null, reason: NO_MODS },
    { chord: "ctrl-shift-l", doriface: null, reason: NO_LAYOUTS },
    { chord: "ctrl-v", doriface: null, reason: CTRL_V_PASTES },
  ],
};

/** An Alt chord family a default binds to a Doriterm action, though a program reads Alt+<key> as a Meta key. */
export interface AltKept {
  /** The family's default triggers, in Doriterm's trigger spelling. */
  readonly trigger: RegExp;
  /** The actions those triggers may carry. */
  readonly action: RegExp;
  readonly reason: string;
}

/**
 * Every family of Alt chords a default keymap gives to a Doriterm action; any other Alt chord is the program's (#1302,
 * #1942). Each family is herdr-app's own default and acts from a focused terminal as herdr-app's does (#1925); a person
 * whose program needs one of these keys unbinds that row in Settings > Keyboard. `program-keys.test.ts` holds the
 * defaults to this list both ways.
 */
export const ALT_KEPT: Readonly<Record<Platform, readonly AltKept[]>> = {
  mac: [],
  other: [
    {
      trigger: /^alt\+(shift\+)?[hjkl]$/,
      action: /^pane\.(go|swap):(left|down|up|right)$/,
      reason: "herdr-app's vim pane keys (keys.json alt-h/j/k/l and alt-shift-h/j/k/l), carried over from Ghostty",
    },
    {
      trigger: /^alt\+[1-9]$/,
      action: /^space\.select:[1-9]$/,
      reason:
        "herdr-app's space number chords (keys.json alt-1..9); they act from a focused terminal as in herdr-app (#1925), so a program that wants Alt+<digit> (readline's numeric argument) needs the row unbound",
    },
    {
      trigger: /^alt\+[[\]]$/,
      action: /^tab\.(prev|next)$/,
      reason:
        "herdr-app's tab cycle (keys.json alt-[ and alt-]), and a browser tab's stand-in for Ctrl+Tab, which the browser keeps for itself; Alt+[ is ESC [, the start of every CSI sequence, so few programs can read it",
    },
  ],
};

const numbered = (prefix: string, fallback: string): Record<string, string> =>
  Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`${prefix}${index + 1}`, fallback]));

/**
 * Chords herdr-app binds that a plain browser tab keeps for itself, so there only the installed app (PWA) and the
 * desktop app get them; the fallback is what does the same in a browser tab. Chromium reserves closing and opening tabs
 * and windows and cycling tabs (`kReservedCommandIds`), and lets a page take every other key, reload included.
 */
export const BROWSER_TAB_FALLBACK: Readonly<Record<Platform, Readonly<Record<string, string>>>> = {
  mac: {
    "cmd-t": "the tab bar's + button",
    "cmd-w": "Close tab on the tab, or Cmd+Alt+W",
    "cmd-shift-w": "the pane header's close button",
    "cmd-n": "New space in the tab bar's new menu",
    "cmd-shift-]": "click the tab",
    "cmd-shift-[": "click the tab",
    "ctrl-tab": "click the tab",
    "ctrl-shift-tab": "click the tab",
    ...numbered("cmd-", "click the tab"),
  },
  other: {
    "ctrl-shift-t": "the tab bar's + button",
    "ctrl-shift-w": "Close tab on the tab",
    "ctrl-shift-n": "New space in the tab bar's new menu",
    "ctrl-tab": "Alt+] or click the tab",
    "ctrl-shift-tab": "Alt+[ or click the tab",
    "ctrl-pagedown": "Alt+] or click the tab",
    "ctrl-pageup": "Alt+[ or click the tab",
    ...numbered("ctrl-", "click the tab"),
  },
};
