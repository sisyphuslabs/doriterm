import { DIRECTION_PAD_CLEARANCE, KEYBOARD_BUTTON_CLEARANCE } from "./phone-keys.tsx";

export interface KeysState {
  /** The keys ride on the soft keyboard, or (mouse-only) were opened by hand. */
  readonly riding: boolean;
  /** The session menu or the packs panel is open over keys that rode on the keyboard as it opened. */
  readonly held: boolean;
  readonly mouseOnly: boolean;
  readonly ended: boolean;
  readonly dictating: boolean;
  readonly browsing: boolean;
  readonly offline: boolean;
  /** The terminal is in a tab of its space, so a tabs bar can show under it. */
  readonly inTab: boolean;
  /** The arrow pad is open over the keys. */
  readonly pad: boolean;
}

export interface KeysPlacement {
  /** The keys ride on the keyboard: the terminal keeps clear of them and the tabs bar gives way. */
  readonly keysOpen: boolean;
  readonly tabsBar: boolean;
  /** The room the keys keep below themselves while docked under the terminal; null while they are not (see PhoneKeys). */
  readonly docked: string | null;
  /** What the terminal's jump button keeps clear of over its bottom right; null for nothing. */
  readonly jumpClearance: string | null;
}

/** Where a phone terminal's keys, tabs bar and round button go in a given state. */
export function keysPlacement(state: KeysState): KeysPlacement {
  const { riding, held, mouseOnly, ended, dictating, browsing, offline, inTab, pad } = state;
  // The packs panel takes the screen for a moment, so the bar stays under it as it does under the session menu: closing
  // the panel puts the person back on the terminal's keyboard.
  const keysOpen = !ended && !dictating && !browsing && (riding || held);
  // The tabs bar takes the bottom while nothing rides there: the keys bar, with the soft keyboard, and dictation do.
  const tabsBar = !keysOpen && !dictating && inTab;
  // A touch phone's keys while its keyboard is down (#1526): the same panel as on the keyboard, under the terminal
  // (#2499). Over the tabs bar it needs no room below; without one, Read-only takes a row of its own under it. A
  // mouse-only window opens its keys bar by hand instead.
  const docked =
    keysOpen || mouseOnly || dictating || browsing || offline || ended
      ? null
      : tabsBar
        ? "0px"
        : KEYBOARD_BUTTON_CLEARANCE;
  // The terminal's jump button stays clear of what floats over its bottom right: the round button, or the arrow pad.
  // Over the tabs bar the round button floats beside the bar, and under the docked keys it has a row of its own: either
  // way under the terminal, not over it (#1555).
  const jumpClearance =
    offline || ended || dictating
      ? null
      : keysOpen || docked !== null
        ? pad
          ? DIRECTION_PAD_CLEARANCE
          : null
        : tabsBar
          ? null
          : KEYBOARD_BUTTON_CLEARANCE;
  return { keysOpen, tabsBar, docked, jumpClearance };
}
