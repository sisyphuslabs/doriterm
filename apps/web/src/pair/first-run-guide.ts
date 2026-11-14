import { useSyncExternalStore } from "react";
import { guardedLocalStorage, type StorageLike } from "../storage/guarded.ts";
import { type MachineIds, storedTerminalKey, tabAddress, tabKey, terminalKeyOn } from "../workspace/tab-keys.ts";

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
  /**
   * The terminal it last started or opened, by its tab key (`tab-keys.ts`): its machine's permanent id rather than its name,
   * so a rename before the list shows it still finds it (#1198). Null before that, or in a record an app before #834 saved.
   */
  readonly key: string | null;
}

const NO_IDS: MachineIds = { byName: new Map(), byId: new Map() };

export const GUIDE_KEY = "doriface.firstRunGuide";
const OFF: GuideState = { status: "off", opened: false, key: null };
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
  const key: unknown = Reflect.get(parsed, "key");
  // A record an app before #1198 saved names the terminal by its address: kept as the name-based key that address has.
  const address: unknown = Reflect.get(parsed, "address");
  const known = STATUSES.find((entry) => entry === status);
  const remembered = typeof key === "string" ? key : typeof address === "string" ? tabKey(address, NO_IDS) : null;
  return known === undefined ? OFF : { status: known, opened: opened === true, key: remembered };
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
    this.#set({ status: "active", opened: false, key: null });
  }

  /** This device started or opened the terminal at `address` (`ids`: the machines as now named); counts only while the guide runs. */
  opened(address: string, ids: MachineIds): void {
    // Kept by permanent id (#2537): a terminal of the host this page goes through is `local:` only on this route.
    const key = storedTerminalKey(tabKey(address, ids), ids.core ?? "");
    if (this.#value.status === "active" && this.#value.key !== key) this.#set({ ...this.#value, opened: true, key });
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
  /** The addresses of the live terminals the list holds. */
  readonly live: readonly string[];
  /** The machines as now named, to find the remembered terminal at its address today. */
  readonly ids: MachineIds;
}

/** The three steps in order, each done by its own event; the first one not done is current. */
export function guideSteps(state: GuideState, facts: GuideFacts): readonly GuideStep[] {
  // The list step is about the terminal this device opened, not any live one the host already had (#834). A record
  // from before #834 names none, so for it any live terminal still counts.
  const address =
    state.key === null ? undefined : tabAddress(terminalKeyOn(state.key, facts.ids.core ?? ""), facts.ids);
  const listed = state.key === null ? facts.live.length > 0 : address !== undefined && facts.live.includes(address);
  const done = [true, state.opened, state.opened && facts.listVisible && listed];
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
