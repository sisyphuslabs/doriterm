import { createContext, useContext } from "react";

/** Read-only browsing (browse-mode.ts) of the phone terminal in view, and its switch. */
export interface PhoneBrowse {
  readonly browsing: boolean;
  readonly setBrowsing: (on: boolean) => void;
}

/** The open tab's place in its space (from 0), how many tabs it has, and the switch's accessible name. */
export interface TabsPlace {
  readonly at: number;
  readonly count: number;
  readonly label: string;
}

/** The open tab's place, and what opens the switch sheet. */
export interface PhoneTabsPlace extends TabsPlace {
  readonly openSwitch: () => void;
}

/**
 * What the phone terminal screen, which owns the state, hands the session sheet in its header (#2879): Read-only, which
 * keeps no round button of its own so the keys need no row under the terminal, and the tabs switch, which the sheet
 * offers on a portrait phone, where the header keeps no room for its chip. Each is null where the terminal has none (Read-only on a
 * mouse-only window, an offline machine or an ended view; tabs for a terminal in no space's tab).
 */
export interface PhoneSessionExtras {
  readonly browse: PhoneBrowse | null;
  readonly tabs: PhoneTabsPlace | null;
}

export const PhoneSessionExtrasContext = createContext<PhoneSessionExtras>({ browse: null, tabs: null });

export const usePhoneSessionExtras = (): PhoneSessionExtras => useContext(PhoneSessionExtrasContext);
