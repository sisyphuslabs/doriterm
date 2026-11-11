/** Where the phone is (a space screen, an open terminal), from the route alone. */

/** The phone's two sections, its bottom tab bar's first two tabs: the agents (the root, `/`) and the spaces (`?v=spaces`). */
export type PhoneSection = "agents" | "spaces";

/**
 * The phone's place in the list route: its section (`?v=spaces`, else the agents), the space screen it shows
 * (`?s=<space key>`), the terminal open over it or over the list (`?t=<tab key>`) and the switch sheet open over that
 * terminal (`&sheet=switch`). A screen opened from another keeps the keys of the one it came from, so its Back knows
 * where it goes.
 */
export interface PhoneRoute {
  readonly section: PhoneSection;
  readonly space: string | null;
  readonly terminal: string | null;
  /** Whether the switch sheet is open over the terminal: an entry of its own, so Back closes only the sheet. */
  readonly sheet: boolean;
}

export const PHONE_LIST: PhoneRoute = { section: "agents", space: null, terminal: null, sheet: false };

const param = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** The route the list's search params name; anything that is not a non-empty string names nothing. */
export const phoneRoute = (search: {
  readonly v?: unknown;
  readonly s?: unknown;
  readonly t?: unknown;
  readonly sheet?: unknown;
}): PhoneRoute => {
  const terminal = param(search.t);
  return {
    section: search.v === "spaces" ? "spaces" : "agents",
    space: param(search.s),
    terminal,
    // The sheet switches the open terminal's tab: with no terminal open there is nothing for it to sit over.
    sheet: terminal !== null && search.sheet === "switch",
  };
};

/** The list's address for a route: `v`, `s`, `t`, then `sheet`, each URI-encoded; the bare agents list is `/`. */
export function phoneHref(route: PhoneRoute): string {
  const params = [
    ...(route.section === "spaces" ? ["v=spaces"] : []),
    ...(route.space === null ? [] : [`s=${encodeURIComponent(route.space)}`]),
    ...(route.terminal === null ? [] : [`t=${encodeURIComponent(route.terminal)}`]),
    ...(route.sheet && route.terminal !== null ? ["sheet=switch"] : []),
  ];
  return params.length === 0 ? "/" : `/?${params.join("&")}`;
}

/**
 * One level up: the switch sheet closes to its terminal, a terminal to the screen it was opened from (its space, else its
 * section's list), a space to its section's list, and the spaces list to the agents.
 */
export function phoneParent(route: PhoneRoute): PhoneRoute {
  if (route.sheet) return { ...route, sheet: false };
  if (route.terminal !== null) return { ...route, terminal: null };
  if (route.space !== null) return { ...route, space: null };
  return PHONE_LIST;
}

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
