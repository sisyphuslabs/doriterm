import type { AvatarColor } from "@doriface/ui";
import { AVATAR_COLORS } from "@doriface/ui";
import { useEffect, useSyncExternalStore } from "react";
import { machineOf } from "./model.ts";
import { assignColors, type AgentSort } from "./sidebar-model.ts";
import { guardedLocalStorage } from "../storage/guarded.ts";

/** The sidebar's own choices that outlive a reload: how agents sort, and each space's avatar colour. */
export interface SidebarPrefs {
  readonly sort: AgentSort;
  readonly colors: Readonly<Record<string, AvatarColor>>;
  /** Machines (by id) whose spaces are folded under their header. */
  readonly collapsed: readonly string[];
  /** Agents (by address) whose sub-agents are folded under their row, on this device (#2746). */
  readonly folded: readonly string[];
}

export const SIDEBAR_KEY = "doriface.sidebar";
const DEFAULT: SidebarPrefs = { sort: "status", colors: {}, collapsed: [], folded: [] };

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];

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
  const kept =
    typeof colors === "object" && colors !== null
      ? Object.fromEntries(Object.entries(colors).filter((entry): entry is [string, AvatarColor] => isColor(entry[1])))
      : {};
  return {
    sort: sort === "space" ? "space" : "status",
    colors: kept,
    collapsed: strings(Reflect.get(parsed, "collapsed")),
    folded: strings(Reflect.get(parsed, "folded")),
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

/** Each listed space's colour; a new space gets one (and the choice is saved) the first time it is listed. */
export function useSpaceColors(ids: readonly string[]): Readonly<Record<string, AvatarColor>> {
  const saved = useSyncExternalStore(sidebarPrefs.subscribe, () => sidebarPrefs.value.colors);
  const next = assignColors(saved, ids);
  if (next !== saved)
    queueMicrotask(() => sidebarPrefs.update({ colors: assignColors(sidebarPrefs.value.colors, ids) }));
  return next;
}

/** Whether a machine's spaces are folded, and the toggle; the choice outlives a reload. */
export function useCollapsed(): readonly [readonly string[], (id: string) => void] {
  const collapsed = useSyncExternalStore(sidebarPrefs.subscribe, () => sidebarPrefs.value.collapsed);
  const toggle = (id: string): void => {
    const now = sidebarPrefs.value.collapsed;
    sidebarPrefs.update({ collapsed: now.includes(id) ? now.filter((one) => one !== id) : [...now, id] });
  };
  return [collapsed, toggle];
}

/**
 * The folds that are still of a listed agent (`listed`, the live ones), so the saved list cannot grow without bound.
 * Nothing is dropped before the terminal list has loaded: a reload would otherwise wipe every fold before the feed
 * arrives. An added machine's folds wait the same way until its feed lists a terminal in any state (`fed`, every address
 * the feed lists), so one whose terminals arrive later keeps them and one whose agents have all finished does not, but
 * only while it is still in the machine list (`added`, its names; null before machine.list has answered). Gives back
 * `folded` itself when nothing goes.
 */
export function pruneFolded(
  folded: readonly string[],
  listed: ReadonlySet<string>,
  fed: ReadonlySet<string>,
  terminalsLoaded: boolean,
  added: ReadonlySet<string> | null,
): readonly string[] {
  if (!terminalsLoaded) return folded;
  const feeding = new Set([...fed].map(machineOf));
  const waiting = (machine: string | undefined): boolean =>
    machine !== undefined && !feeding.has(machine) && (added === null || added.has(machine));
  const kept = folded.filter((address) => listed.has(address) || waiting(machineOf(address)));
  return kept.length === folded.length ? folded : kept;
}

/**
 * The agents whose sub-agents are folded, and the toggle; the choice outlives a reload, on this device. `listed` is the
 * addresses the Agents list draws and `fed` every address the feed lists: a fold of one that is gone is dropped once
 * the terminals have loaded (`pruneFolded`).
 */
export function useFolded(
  listed: ReadonlySet<string>,
  fed: ReadonlySet<string>,
  terminalsLoaded: boolean,
  added: ReadonlySet<string> | null,
): readonly [readonly string[], (address: string) => void] {
  const folded = useSyncExternalStore(sidebarPrefs.subscribe, () => sidebarPrefs.value.folded);
  useEffect(() => {
    const kept = pruneFolded(sidebarPrefs.value.folded, listed, fed, terminalsLoaded, added);
    if (kept !== sidebarPrefs.value.folded) sidebarPrefs.update({ folded: kept });
  }, [folded, listed, fed, terminalsLoaded, added]);
  const toggle = (address: string): void => {
    const now = sidebarPrefs.value.folded;
    sidebarPrefs.update({ folded: now.includes(address) ? now.filter((one) => one !== address) : [...now, address] });
  };
  return [folded, toggle];
}
