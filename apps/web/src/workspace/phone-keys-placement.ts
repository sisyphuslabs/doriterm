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
  /** The arrow pad is open over the keys. */
  readonly pad: boolean;
}

export interface KeysPlacement {
  /** The keys ride on the keyboard: the terminal keeps clear of them. */
  readonly keysOpen: boolean;
  /** The room the keys keep below themselves while docked under the terminal; null while they are not (see PhoneKeys). */
  readonly docked: string | null;
  /** What the terminal's jump button keeps clear of over its bottom right; null for nothing. */
  readonly jumpClearance: string | null;
}

/** Where a phone terminal's keys and round button go in a given state. */
export function keysPlacement(state: KeysState): KeysPlacement {
  const { riding, held, mouseOnly, ended, dictating, browsing, offline, pad } = state;
  // The packs panel takes the screen for a moment, so the bar stays under it as it does under the session menu: closing
  // the panel puts the person back on the terminal's keyboard.
  const keysOpen = !ended && !dictating && !browsing && (riding || held);
  // A touch phone's keys while its keyboard is down (#1526): the same panel as on the keyboard, under the terminal
  // (#2499), on the home inset and nothing else, as in the Herdr app: no tabs strip under it and no row of its own for a
  // round button (#2879). A mouse-only window opens its keys bar by hand instead.
  const docked = keysOpen || mouseOnly || dictating || browsing || offline || ended ? null : "var(--safe-bottom)";
  // The terminal's jump button stays clear of what floats over its bottom right: the round button (Read-only while
  // browsing, Show keys on a mouse-only window), or the arrow pad (#1555).
  const jumpClearance =
    offline || ended || dictating
      ? null
      : keysOpen || docked !== null
        ? pad
          ? DIRECTION_PAD_CLEARANCE
          : null
        : KEYBOARD_BUTTON_CLEARANCE;
  return { keysOpen, docked, jumpClearance };
}
