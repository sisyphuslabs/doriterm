import { useSyncExternalStore } from "react";
import { guardedLocalStorage, type StorageLike } from "../storage/guarded.ts";

/**
 * The first run on a newly paired device (#668): pair, then start or pick an agent, then see it in the agents list.
 * Each step is done by the event itself (the pairing, this device starting a terminal or opening one from the list, the
 * list showing a live terminal after that), never by a restored focus or a click on the guide. The guide can be skipped, and reopened from Settings.
 */
export type GuideStatus = "off" | "active" | "skipped" | "done";

export interface GuideState {
  readonly status: GuideStatus;
  /** This device started a terminal, or opened one from the agents list, since the guide started. */
  readonly opened: boolean;
}

export const GUIDE_KEY = "doriface.firstRunGuide";
const OFF: GuideState = { status: "off", opened: false };
const STATUSES: readonly GuideStatus[] = ["off", "active", "skipped", "done"];

export function loadGuide(storage: Pick<StorageLike, "getItem"> = guardedLocalStorage()): GuideState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storage.getItem(GUIDE_KEY) ?? "null");
  } catch {
    return OFF;
  }
  if (typeof parsed !== "object" || parsed === null) return OFF;
  const status: unknown = Reflect.get(parsed, "status");
  const opened: unknown = Reflect.get(parsed, "opened");
  const known = STATUSES.find((entry) => entry === status);
  return known === undefined ? OFF : { status: known, opened: opened === true };
}

export class GuideStore {
  #value: GuideState;
  readonly #storage: StorageLike;
  readonly #listeners = new Set<() => void>();

  constructor(storage: StorageLike = guardedLocalStorage()) {
    this.#storage = storage;
    this.#value = loadGuide(storage);
  }

  get value(): GuideState {
    return this.#value;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** A pairing finished on this device, or Settings reopened the guide: every step after pairing starts over. */
  start(): void {
    this.#set({ status: "active", opened: false });
  }

  /** This device started or opened a terminal; counts only while the guide runs. */
  opened(): void {
    if (this.#value.status === "active" && !this.#value.opened) this.#set({ ...this.#value, opened: true });
  }

  skip(): void {
    if (this.#value.status === "active") this.#set({ ...this.#value, status: "skipped" });
  }

  finish(): void {
    if (this.#value.status === "active") this.#set({ ...this.#value, status: "done" });
  }

  #set(next: GuideState): void {
    this.#value = next;
    this.#storage.setItem(GUIDE_KEY, JSON.stringify(next));
    for (const listener of this.#listeners) listener();
  }
}

export const guideStore = new GuideStore();

export function useGuide(store: GuideStore = guideStore): GuideState {
  return useSyncExternalStore(store.subscribe, () => store.value);
}

export type StepState = "done" | "current" | "todo";

export interface GuideStep {
  readonly id: "pair" | "agent" | "list";
  readonly label: string;
  readonly state: StepState;
}

export interface GuideFacts {
  /** The agents list is on screen (always on a desktop; on a phone, when no terminal fills the screen). */
  readonly listVisible: boolean;
  /** The list holds at least one live terminal. */
  readonly listedLive: boolean;
}

/** The three steps in order, each done by its own event; the first one not done is current. */
export function guideSteps(state: GuideState, facts: GuideFacts): readonly GuideStep[] {
  const done = [true, state.opened, state.opened && facts.listVisible && facts.listedLive];
  const current = done.indexOf(false);
  const labels = [
    ["pair", "Pair this device"],
    ["agent", "Start an agent, or open one"],
    ["list", "See it in the agents list"],
  ] as const;
  return labels.map(([id, label], index) => ({
    id,
    label,
    state: done[index] === true ? "done" : index === current ? "current" : "todo",
  }));
}
