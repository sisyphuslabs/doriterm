import { guardedLocalStorage, type StorageLike } from "../storage/guarded.ts";
import { PHONE_LIST, type PhoneRoute, phoneRoute } from "./phone-route.ts";

export const PHONE_PLACE_KEY = "doriface.phone-place";

/**
 * Where the phone was in its list route the last time it moved there: its section, the space screen and the terminal it
 * showed. The switch sheet is not a place (a reopened app never starts on a sheet). Junk, or storage that refuses the
 * read, is the bare agents list.
 */
export function loadPhonePlace(storage: StorageLike = guardedLocalStorage()): PhoneRoute {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storage.getItem(PHONE_PLACE_KEY) ?? "null");
  } catch {
    return PHONE_LIST;
  }
  if (typeof parsed !== "object" || parsed === null) return PHONE_LIST;
  return phoneRoute({ v: Reflect.get(parsed, "v"), s: Reflect.get(parsed, "s"), t: Reflect.get(parsed, "t") });
}

/** Keeps the phone's place for the next cold start on `/`; the sheet is left out. */
export function savePhonePlace(route: PhoneRoute, storage: StorageLike = guardedLocalStorage()): void {
  storage.setItem(
    PHONE_PLACE_KEY,
    JSON.stringify({ v: route.section === "spaces" ? "spaces" : null, s: route.space, t: route.terminal }),
  );
}
