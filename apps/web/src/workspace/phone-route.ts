/** Which terminal the phone has open, from the route alone. */

/**
 * The phone's open terminal lives in the route (`/?t=<key>`), so the list needs no second copy of it. A route that is not
 * the list says nothing about `?t=` — Settings and pairing are mounted over this same workspace (#607) — so it keeps the
 * last terminal the list had open instead of reporting that nothing is open, which unmounted the terminal and reattached
 * it when the sheet closed.
 */
export const phoneOpenKey = (path: string, routeKey: string | null, lastOpen: string | null): string | null =>
  path === "/" ? routeKey : lastOpen;

/** The last terminal a `/` route had open, to carry across the routes that are not the list. */
export const rememberOpenKey = (path: string, routeKey: string | null, lastOpen: string | null): string | null =>
  path === "/" && routeKey !== null ? routeKey : lastOpen;

/**
 * Whether opening this terminal added a history entry. Entering from the list does; a switch inside an open terminal
 * replaces the entry that is already there, so Back must not find a second list entry to land on.
 */
export const entersFromList = (routeKey: string | null): boolean => routeKey === null;
