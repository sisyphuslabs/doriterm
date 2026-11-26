import { createContext, useContext } from "react";

/** Read-only browsing (browse-mode.ts) of the phone terminal in view, and its switch. */
export interface PhoneBrowse {
  readonly browsing: boolean;
  readonly setBrowsing: (on: boolean) => void;
}

/**
 * Held by the phone terminal screen, which owns the state, for the session sheet in its header, which turns it on
 * (#2879): the screen keeps no round button for it, so the keys need no row of their own under the terminal. Null where
 * the terminal takes no browsing (a mouse-only window, an offline machine, an ended view).
 */
export const PhoneBrowseContext = createContext<PhoneBrowse | null>(null);

export const usePhoneBrowse = (): PhoneBrowse | null => useContext(PhoneBrowseContext);
