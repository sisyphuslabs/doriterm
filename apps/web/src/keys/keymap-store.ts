import { useSyncExternalStore } from "react";
import { deviceStore, memoryStore, type KeyValueStore } from "../storage/idb.ts";
import { checkBinding, NO_OVERRIDES, type Overrides } from "./keymap.ts";

const KEY = "keymap";
/** 2: `pane.split` became `pane.split:right` when split down arrived, so a build before that leaves this keymap alone. */
export const KEYMAP_VERSION = 2;

/** The stored keymap is a newer build's: this one reads its defaults and writes nothing. */
export class NewerKeymapError extends Error {
  constructor() {
    super("The keymap was saved by a newer version of Doriterm; it is left as it is.");
    this.name = "NewerKeymapError";
  }
}

interface Stored {
  readonly version: number;
  readonly bindings: readonly (readonly [string, string | null])[];
}

function isStored(value: unknown): value is Stored {
  if (typeof value !== "object" || value === null) return false;
  const version: unknown = Reflect.get(value, "version");
  const bindings: unknown = Reflect.get(value, "bindings");
  return typeof version === "number" && Array.isArray(bindings);
}

/** Actions renamed since a binding was saved: split became split right when split down arrived. */
const RENAMED: Readonly<Record<string, string>> = { "pane.split": "pane.split:right" };

/** Bindings to actions this build does not know (a newer build's), kept so the next save writes them back. */
type Foreign = ReadonlyMap<string, string>;

interface Read {
  readonly overrides: Overrides;
  readonly foreign: Foreign;
}

/** Older layouts are read through here; a shape this version cannot read keeps the defaults. */
function migrate(layout: Stored): Read {
  const overrides = new Map<string, string | null>();
  const foreign = new Map<string, string>();
  for (const entry of layout.bindings) {
    if (!Array.isArray(entry)) continue;
    const [trigger, saved] = entry;
    if (typeof trigger !== "string" || (typeof saved !== "string" && saved !== null)) continue;
    const action = saved === null ? null : (RENAMED[saved] ?? saved);
    const checked = checkBinding(trigger, action);
    if (checked.ok) overrides.set(checked.trigger, action);
    else if (action !== null) {
      const key = checkBinding(trigger, null);
      if (key.ok) foreign.set(key.trigger, action);
    }
  }
  return { overrides, foreign };
}

/** What is saved: this build's bindings, then the unknown ones on keys it does not bind itself. */
function stored(overrides: Overrides, foreign: Foreign): Stored {
  const kept = [...foreign].filter(([trigger]) => !overrides.has(trigger));
  return { version: KEYMAP_VERSION, bindings: [...overrides, ...kept] };
}

export class KeymapStore {
  #overrides: Overrides = NO_OVERRIDES;
  #foreign: Foreign = new Map();
  #queue: Promise<void>;
  #error: Error | null = null;
  #listeners = new Set<() => void>();
  readonly #storage: KeyValueStore;
  readonly loaded: Promise<void>;

  constructor(storage: KeyValueStore) {
    this.#storage = storage;
    this.loaded = this.#load().catch((cause: unknown) => {
      this.#error = cause instanceof Error ? cause : new Error(String(cause));
      for (const listener of this.#listeners) listener();
    });
    this.#queue = this.loaded;
  }

  get overrides(): Overrides {
    return this.#overrides;
  }

  /** Set when the stored value could not be read; writes are refused so nothing stored is overwritten. */
  get error(): Error | null {
    return this.#error;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Refuses the whole write when any binding is invalid, so storage never holds a bad trigger. */
  update(change: (current: Overrides) => Overrides): Promise<void> {
    const applied = this.#queue.then(async () => this.#apply(change));
    this.#queue = applied.catch(() => undefined);
    return applied;
  }

  async #apply(change: (current: Overrides) => Overrides): Promise<void> {
    if (this.#error !== null) return;
    const next = change(this.#overrides);
    for (const [trigger, action] of next) {
      const checked = checkBinding(trigger, action);
      if (!checked.ok) throw new Error(checked.reason);
    }
    this.#set(next);
    await this.#storage.put(KEY, stored(next, this.#foreign));
  }

  async #load(): Promise<void> {
    const raw = await this.#storage.get(KEY);
    if (!isStored(raw)) return;
    // A newer build's keymap is left as it is, so going back a version never rewrites it: this build takes no writes.
    if (raw.version > KEYMAP_VERSION) throw new NewerKeymapError();
    const read = migrate(raw);
    if (raw.version < KEYMAP_VERSION) {
      await this.#storage.put(`${KEY}.backup.v${raw.version}`, raw);
      await this.#storage.put(KEY, stored(read.overrides, read.foreign));
    }
    this.#foreign = read.foreign;
    this.#set(read.overrides);
  }

  #set(overrides: Overrides): void {
    this.#overrides = overrides;
    for (const listener of this.#listeners) listener();
  }
}

export const keymapStore = new KeymapStore(typeof indexedDB === "undefined" ? memoryStore() : deviceStore);

export function useOverrides(store: KeymapStore = keymapStore): Overrides {
  return useSyncExternalStore(store.subscribe, () => store.overrides);
}

export function useKeymapError(store: KeymapStore = keymapStore): Error | null {
  return useSyncExternalStore(store.subscribe, () => store.error);
}
