import type { MachineIds } from "../workspace/tab-keys.ts";
import type { Seen, View } from "./view.ts";

/**
 * A view's keys as they are stored, apart from the host this page reaches the others through (#2537). In memory a tab of
 * that host is keyed bare (`tb-1`) and every other machine's tab by its permanent id (`<id>/tb-1`); stored, the bare ones
 * carry the host's id too, so the same tab has the same key whichever host the next load goes through. Seen marks are
 * keyed by terminal address, which names a machine by what this host calls it (or not at all, for its own terminals), so
 * they are kept apart: in memory and stored alike as `@<machine id>/<address on that machine>` (`storedSeen`), and
 * turned into this page's addresses only where they are matched (`seenOn`).
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
    (mark) => mark,
  );
}

/** A stored view as this page keys it: the host it goes through keyed bare again, every other machine by id. */
export function viewOn(stored: View, core: string): View {
  return mapped(
    stored,
    (key) => relative(key, core),
    (key) => spaceKeyed(relative)(key, core),
    (mark) => mark,
  );
}

/**
 * Marks keyed by this page's addresses, as kept: `t1` is the core's (`@<core>/t1`), `box/t2` the machine this host
 * calls box (`@<box's id>/t2`). A machine not named yet keeps the address it has.
 */
export function storedSeen(marks: Seen, core: string, ids: MachineIds): Seen {
  return rekeyed(marks, (address) => {
    if (address.startsWith(SEEN)) return address;
    const slash = address.indexOf("/");
    if (slash === -1) return core === "" ? address : `${SEEN}${core}/${address}`;
    const id = ids.byName.get(address.slice(0, slash));
    return id === undefined ? address : `${SEEN}${id}${address.slice(slash)}`;
  });
}

/** Kept marks as this page's addresses; a mark of a machine this host does not list now is left out. */
export function seenOn(seen: Seen, core: string, ids: MachineIds): Seen {
  const shown: Record<string, string> = {};
  for (const [key, mark] of Object.entries(seen)) {
    if (!key.startsWith(SEEN)) {
      shown[key] = mark;
      continue;
    }
    const slash = key.indexOf("/");
    const id = key.slice(SEEN.length, slash);
    const name = id === core ? null : ids.byId.get(id);
    if (name === undefined) continue;
    shown[name === null ? key.slice(slash + 1) : `${name}${key.slice(slash)}`] = mark;
  }
  return shown;
}
