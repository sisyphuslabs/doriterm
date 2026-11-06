import { useSyncExternalStore } from "react";
import { deviceStore, memoryStore, type KeyValueStore } from "../storage/idb.ts";
import { defaultSettings, type KeyBarSettings, reviveSettings } from "./settings.ts";

const KEY = "key-bar";

/**
 * This device's keys bar. Loaded once from IndexedDB and saved on every change; changes are updaters applied in order
 * on top of the loaded document, so one made before the load finishes keeps every stored key.
 */
export class KeyBarStore {
  #settings: KeyBarSettings = defaultSettings();
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

  get settings(): KeyBarSettings {
    return this.#settings;
  }

  /** Set when the stored document could not be read; writes are refused so nothing stored is overwritten. */
  get error(): Error | null {
    return this.#error;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  update(change: (current: KeyBarSettings) => KeyBarSettings): Promise<void> {
    const applied = this.#queue.then(async () => this.#apply(change));
    this.#queue = applied.catch(() => undefined);
    return applied;
  }

  async #apply(change: (current: KeyBarSettings) => KeyBarSettings): Promise<void> {
    if (this.#error !== null) return;
    const next = change(this.#settings);
    if (next === this.#settings) return;
    this.#set(next);
    await this.#storage.put(KEY, next);
  }

  async #load(): Promise<void> {
    this.#set(reviveSettings(await this.#storage.get(KEY)));
  }

  #set(settings: KeyBarSettings): void {
    this.#settings = settings;
    for (const listener of this.#listeners) listener();
  }
}

export const keyBarStore =
  typeof indexedDB === "undefined" ? new KeyBarStore(memoryStore()) : new KeyBarStore(deviceStore);

export function useKeyBarSettings(store: KeyBarStore = keyBarStore): KeyBarSettings {
  return useSyncExternalStore(store.subscribe, () => store.settings);
}

export function useKeyBarError(store: KeyBarStore = keyBarStore): Error | null {
  return useSyncExternalStore(store.subscribe, () => store.error);
}
