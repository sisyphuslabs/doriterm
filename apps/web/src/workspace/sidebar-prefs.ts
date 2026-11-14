import type { AvatarColor } from "@doriface/ui";
import { AVATAR_COLORS } from "@doriface/ui";
import { useSyncExternalStore } from "react";
import { assignColors, type AgentSort } from "./sidebar-model.ts";
import { guardedLocalStorage } from "../storage/guarded.ts";
import { spaceKeyOn, storedSpaceKey } from "../layout/view-keys.ts";

/** The sidebar's own choices that outlive a reload: how agents sort, and each space's avatar colour. */
export interface SidebarPrefs {
  readonly sort: AgentSort;
  readonly colors: Readonly<Record<string, AvatarColor>>;
  /** Machines (by permanent core id) whose spaces are folded under their header. */
  readonly collapsed: readonly string[];
}

export const SIDEBAR_KEY = "doriface.sidebar";
const DEFAULT: SidebarPrefs = { sort: "status", colors: {}, collapsed: [] };

const isColor = (value: unknown): value is AvatarColor => AVATAR_COLORS.some((color) => color === value);

export function loadSidebarPrefs(storage: Pick<Storage, "getItem"> = guardedLocalStorage()): SidebarPrefs {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storage.getItem(SIDEBAR_KEY) ?? "null");
  } catch {
    return DEFAULT;
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULT;
  const sort: unknown = Reflect.get(parsed, "sort");
  const colors: unknown = Reflect.get(parsed, "colors");
  const collapsed: unknown = Reflect.get(parsed, "collapsed");
  const kept =
    typeof colors === "object" && colors !== null
      ? Object.fromEntries(Object.entries(colors).filter((entry): entry is [string, AvatarColor] => isColor(entry[1])))
      : {};
  return {
    sort: sort === "space" ? "space" : "status",
    colors: kept,
    collapsed: Array.isArray(collapsed) ? collapsed.filter((id): id is string => typeof id === "string") : [],
  };
}

class SidebarPrefsStore {
  #value = loadSidebarPrefs();
  #listeners = new Set<() => void>();
  get value(): SidebarPrefs {
    return this.#value;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  update(patch: Partial<SidebarPrefs>): void {
    this.#value = { ...this.#value, ...patch };
    try {
      guardedLocalStorage().setItem(SIDEBAR_KEY, JSON.stringify(this.#value));
    } finally {
      for (const listener of this.#listeners) listener();
    }
  }
}

export const sidebarPrefs = new SidebarPrefsStore();

export function useAgentSort(): readonly [AgentSort, (sort: AgentSort) => void] {
  const sort = useSyncExternalStore(sidebarPrefs.subscribe, () => sidebarPrefs.value.sort);
  return [sort, (next) => sidebarPrefs.update({ sort: next })];
}

/**
 * The saved colours keyed as this page keys spaces when it goes through `core`. They are saved by permanent machine id
 * (#2537), so a space keeps its colour whichever host the page goes through; a key saved before that, bare, was this
 * host's.
 */
export function colorsOn(saved: Readonly<Record<string, AvatarColor>>, core: string): Record<string, AvatarColor> {
  return Object.fromEntries(Object.entries(saved).map(([key, color]) => [spaceKeyOn(key, core), color]));
}

const storedColors = (colors: Readonly<Record<string, AvatarColor>>, core: string): Record<string, AvatarColor> =>
  Object.fromEntries(Object.entries(colors).map(([key, color]) => [storedSpaceKey(key, core), color]));

/**
 * The colours saved before #2537 (space keys bare for the host the page went through, `space:s1`) rewritten by
 * permanent id as the host this page goes through now, or null when none is left. Read the first time a page knows its
 * core, so an old space keeps its colour through a later route change.
 */
export function colorsByCore(
  saved: Readonly<Record<string, AvatarColor>>,
  core: string,
): Record<string, AvatarColor> | null {
  const bare = Object.keys(saved).filter((key) => storedSpaceKey(key, core) !== key);
  if (core === "" || bare.length === 0) return null;
  return Object.fromEntries(Object.entries(saved).map(([key, color]) => [storedSpaceKey(key, core), color]));
}

/**
 * The saved colours without those of spaces deleted from a machine whose layout is read now: `read` maps such a
 * machine's permanent id to the stored keys of the spaces it lists. A machine not read now (offline, or not reached)
 * keeps every colour (#2583). The same record comes back when nothing is dropped.
 */
export function prunedColors(
  saved: Readonly<Record<string, AvatarColor>>,
  read: ReadonlyMap<string, readonly string[]>,
): Readonly<Record<string, AvatarColor>> {
  const gone = Object.keys(saved).filter((key) => {
    const machine = key.startsWith("space:") ? key.slice("space:".length).split("/")[0] : undefined;
    const listed = machine === undefined ? undefined : read.get(machine);
    return listed !== undefined && key.includes("/") && !listed.includes(key);
  });
  return gone.length === 0 ? saved : Object.fromEntries(Object.entries(saved).filter(([key]) => !gone.includes(key)));
}

/** Each listed space's colour; a new space gets one (and the choice is saved) the first time it is listed. */
export function useSpaceColors(
  ids: readonly string[],
  core: string,
  readCores: readonly string[] = [],
): Readonly<Record<string, AvatarColor>> {
  const saved = useSyncExternalStore(sidebarPrefs.subscribe, () => sidebarPrefs.value.colors);
  // Spaces gone from a machine whose layout is read now lose their colour, once, by permanent id (#2583).
  if (core !== "" && readCores.length > 0) {
    const stored = ids.map((id) => storedSpaceKey(id, core));
    const read = new Map(
      readCores.map((machine) => [machine, stored.filter((key) => key.startsWith(`space:${machine}/`))]),
    );
    if (prunedColors(saved, read) !== saved) {
      queueMicrotask(() => {
        const now = prunedColors(sidebarPrefs.value.colors, read);
        if (now !== sidebarPrefs.value.colors) sidebarPrefs.update({ colors: { ...now } });
      });
    }
  }
  const migrated = colorsByCore(saved, core);
  if (migrated !== null) {
    queueMicrotask(() => {
      const again = colorsByCore(sidebarPrefs.value.colors, core);
      if (again !== null) sidebarPrefs.update({ colors: again });
    });
  }
  const shown = colorsOn(migrated ?? saved, core);
  if (ids.every((id) => shown[id] !== undefined)) return shown;
  // Until the page knows the host it goes through, nothing can be saved by permanent id.
  if (core === "") return assignColors(shown, ids);
  // Only a space listed without a colour is written, so a colour kept for a machine not listed now is never dropped
  // and the save settles after one write.
  const next = assignColors(shown, ids);
  queueMicrotask(() => {
    const now = colorsOn(sidebarPrefs.value.colors, core);
    const added = Object.fromEntries(
      ids.flatMap((id) => (now[id] === undefined && next[id] !== undefined ? [[id, next[id]]] : [])),
    );
    if (Object.keys(added).length > 0)
      sidebarPrefs.update({ colors: { ...sidebarPrefs.value.colors, ...storedColors(added, core) } });
  });
  return next;
}

/**
 * The folded machines with the keys saved before #2531 replaced by permanent core ids, or null when none is left: those
 * named the machine this page reached `local` and the others `machine:<name>`, so a fold followed the routing host.
 */
export function collapsedByCore(
  collapsed: readonly string[],
  machines: readonly { readonly id: string; readonly core: string }[],
): readonly string[] | null {
  const byOldKey = new Map(machines.map((machine) => [machine.id, machine.core]));
  if (!collapsed.some((key) => byOldKey.has(key) && byOldKey.get(key) !== key)) return null;
  return [...new Set(collapsed.map((key) => byOldKey.get(key) ?? key))];
}

/** Whether a machine's spaces are folded (by permanent core id), and the toggle; the choice outlives a reload. */
export function useCollapsed(
  machines: readonly { readonly id: string; readonly core: string }[],
): readonly [readonly string[], (core: string) => void] {
  const saved = useSyncExternalStore(sidebarPrefs.subscribe, () => sidebarPrefs.value.collapsed);
  const migrated = collapsedByCore(saved, machines);
  if (migrated !== null) {
    queueMicrotask(() => {
      const again = collapsedByCore(sidebarPrefs.value.collapsed, machines);
      if (again !== null) sidebarPrefs.update({ collapsed: again });
    });
  }
  const collapsed = migrated ?? saved;
  const toggle = (id: string): void => {
    const now = sidebarPrefs.value.collapsed;
    sidebarPrefs.update({ collapsed: now.includes(id) ? now.filter((one) => one !== id) : [...now, id] });
  };
  return [collapsed, toggle];
}
