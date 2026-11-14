import type { View } from "./view.ts";

/**
 * A view's keys as they are stored, apart from the host this page reaches the others through (#2537). In memory a tab of
 * that host is keyed bare (`tb-1`) and every other machine's tab by its permanent id (`<id>/tb-1`); stored, the bare ones
 * carry the host's id too, so the same tab has the same key whichever host the next load goes through. A finish seen on
 * a terminal of that host is stored as `@<id>/<address>`, its address being bare only on that route.
 */
const SPACE = "space:";
const SEEN = "@";

const absolute = (key: string, core: string): string => (key.includes("/") ? key : `${core}/${key}`);
const relative = (key: string, core: string): string => (key.startsWith(`${core}/`) ? key.slice(core.length + 1) : key);

type Rekey = (key: string, core: string) => string;

const spaceKeyed = (rekey: Rekey) => (key: string, core: string) =>
  key.startsWith(SPACE) ? SPACE + rekey(key.slice(SPACE.length), core) : rekey(key, core);

function rekeyed(
  record: Readonly<Record<string, string>>,
  key: (key: string) => string,
  value: (value: string) => string = (same) => same,
): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [key(k), value(v)]));
}

function mapped(
  view: View,
  tab: (key: string) => string,
  space: (key: string) => string,
  seen: (key: string) => string,
) {
  return {
    active: view.active === null ? null : tab(view.active),
    focused: rekeyed(view.focused, tab),
    zoomed: rekeyed(view.zoomed, tab),
    spaces: rekeyed(view.spaces, space, tab),
    seen: rekeyed(view.seen, seen),
  };
}

/** A space key (`space:<id>`) as it is stored, and back as this page keys it, for what is kept per space (colours). */
export const storedSpaceKey = (key: string, core: string): string => spaceKeyed(absolute)(key, core);
export const spaceKeyOn = (key: string, core: string): string => spaceKeyed(relative)(key, core);

/** The view as it is stored: every key names its machine by permanent id. */
export function storedView(view: View, core: string): View {
  return mapped(
    view,
    (key) => absolute(key, core),
    (key) => spaceKeyed(absolute)(key, core),
    (address) => (address.includes("/") ? address : `${SEEN}${core}/${address}`),
  );
}

/** A stored view as this page keys it: the host it goes through keyed bare again, every other machine by id. */
export function viewOn(stored: View, core: string): View {
  return mapped(
    stored,
    (key) => relative(key, core),
    (key) => spaceKeyed(relative)(key, core),
    (address) => (address.startsWith(`${SEEN}${core}/`) ? address.slice(SEEN.length + core.length + 1) : address),
  );
}
