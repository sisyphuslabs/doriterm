import { guardedLocalStorage, type StorageLike } from "../storage/guarded.ts";
import { spaceKeyOn, storedSpaceKey } from "../layout/view-keys.ts";
import { PHONE_LIST, type PhoneRoute, phoneHref, phoneRoute } from "./phone-route.ts";
import { storedTerminalKey, terminalKeyOn } from "./tab-keys.ts";

export const PHONE_PLACE_KEY = "doriface.phone-place";

/**
 * Where the phone was in its list route the last time it moved there: its section, the space screen and the terminal it
 * showed. The switch sheet is not a place (a reopened app never starts on a sheet). Junk, or storage that refuses the
 * read, is the bare agents list.
 */
export function loadPhonePlace(core: string, storage: StorageLike = guardedLocalStorage()): PhoneRoute {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storage.getItem(PHONE_PLACE_KEY) ?? "null");
  } catch {
    return PHONE_LIST;
  }
  if (typeof parsed !== "object" || parsed === null) return PHONE_LIST;
  const kept = phoneRoute({ v: Reflect.get(parsed, "v"), s: Reflect.get(parsed, "s"), t: Reflect.get(parsed, "t") });
  // Kept by permanent machine id (#2537): read back as this page keys them when it goes through `core`.
  return {
    ...kept,
    space: kept.space === null ? null : spaceKeyOn(kept.space, core),
    terminal: kept.terminal === null ? null : terminalKeyOn(kept.terminal, core),
  };
}

export interface PlaceStartFacts {
  /** The route is the bare agents list (`/`), the home screen icon's address. */
  readonly atBareList: boolean;
  /** The page is still on the entry it loaded on: nothing has moved it yet. */
  readonly landedHere: boolean;
  /** A tapped notice is waiting to open its pane. */
  readonly noticePending: boolean;
  /** An app is still asking for the tap that launched it (asynchronous): a notice may yet decide the start. */
  readonly launchPending: boolean;
  /** The remembered place's address. */
  readonly remembered: string;
}

/**
 * What a cold start does with the remembered place: restore it, stay where the address put it, or wait while an app's
 * launch tap is unknown. A notice wins over the remembered place, so an app has to know first whether one launched it.
 */
export function placeStart(facts: PlaceStartFacts): "restore" | "stay" | "wait" {
  if (!facts.atBareList || !facts.landedHere) return "stay";
  if (facts.launchPending) return "wait";
  return facts.noticePending || facts.remembered === "/" ? "stay" : "restore";
}

/**
 * Whether the place the route is on is kept. While a restore is on its way only the bare list it is leaving is held back;
 * whatever the route lands on next (the restored place, or a notice opened over it) is kept, so saving never stalls.
 */
export const keepsPlace = (place: string, restoring: boolean): boolean => !(restoring && place === "/");

/** A place made through core `from` as the page keys it through core `to` (#2588): the same space and terminal. */
export function rekeyPlace(route: PhoneRoute, from: string, to: string): PhoneRoute {
  if (from === "" || to === "" || from === to) return route;
  return {
    ...route,
    space: route.space === null ? null : spaceKeyOn(storedSpaceKey(route.space, from), to),
    terminal: route.terminal === null ? null : terminalKeyOn(storedTerminalKey(route.terminal, from), to),
  };
}

/** An address (`/?s=...&t=...`) made through core `from`, as it reads through core `to`. */
export function rekeyPlaceHref(href: string, from: string, to: string): string {
  const search = Object.fromEntries(new URL(href, "http://x").searchParams);
  return phoneHref(rekeyPlace(phoneRoute(search), from, to));
}

/** Keeps the phone's place for the next cold start on `/`; the sheet is left out. */
export function savePhonePlace(route: PhoneRoute, core: string, storage: StorageLike = guardedLocalStorage()): void {
  const s = route.space === null || core === "" ? route.space : storedSpaceKey(route.space, core);
  const t = route.terminal === null ? null : storedTerminalKey(route.terminal, core);
  storage.setItem(PHONE_PLACE_KEY, JSON.stringify({ v: route.section === "spaces" ? "spaces" : null, s, t }));
}
