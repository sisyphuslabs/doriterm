/** Where the phone is (a space screen, an open terminal), from the route alone. */

/**
 * The phone's place in the list route: the space screen it shows (`?s=<space key>`) and the terminal open over it or over
 * the list (`?t=<tab key>`). A terminal opened from a space keeps its `s`, so its Back knows where it came from.
 */
export interface PhoneRoute {
  readonly space: string | null;
  readonly terminal: string | null;
}

export const PHONE_LIST: PhoneRoute = { space: null, terminal: null };

const param = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** The route the list's search params name; anything that is not a non-empty string names nothing. */
export const phoneRoute = (search: { readonly s?: unknown; readonly t?: unknown }): PhoneRoute => ({
  space: param(search.s),
  terminal: param(search.t),
});

/** The list's address for a route: `s` before `t`, each URI-encoded; the bare list is `/`. */
export function phoneHref(route: PhoneRoute): string {
  const params = [
    ...(route.space === null ? [] : [`s=${encodeURIComponent(route.space)}`]),
    ...(route.terminal === null ? [] : [`t=${encodeURIComponent(route.terminal)}`]),
  ];
  return params.length === 0 ? "/" : `/?${params.join("&")}`;
}

/** One level up: a terminal closes to the screen it was opened from (its space, else the list), a space to the list. */
export const phoneParent = (route: PhoneRoute): PhoneRoute =>
  route.terminal === null ? PHONE_LIST : { ...route, terminal: null };

/**
 * The phone's open terminal lives in the route (`/?t=<key>`), so the list needs no second copy of it. A route that is not
 * the list says nothing about `?t=` — Settings and pairing are mounted over this same workspace (#607) — so it keeps the
 * last terminal the list had open instead of reporting that nothing is open, which unmounted the terminal and reattached
 * it when the sheet closed.
 */
export const phoneOpenKey = (path: string, routeKey: string | null, lastOpen: string | null): string | null =>
  path === "/" ? routeKey : (routeKey ?? lastOpen);

/**
 * The last terminal a `/` route had open, to carry across the routes that are not the list. The list with no `?t=` is
 * one that closed it (Back), so it is forgotten there: a Settings opened afterwards keeps no closed terminal mounted
 * under its sheet, counted as in view (review of #1078).
 */
export const rememberOpenKey = (path: string, routeKey: string | null, lastOpen: string | null): string | null =>
  routeKey ?? (path === "/" ? null : lastOpen);
