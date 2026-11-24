import { useSyncExternalStore } from "react";
import { single, withValues, type TerminalConfig } from "../ghostty/config.ts";
import { type TerminalConfigStore, terminalConfigStore } from "../ghostty/config-store.ts";
import { deviceStore, memoryStore, type KeyValueStore } from "../storage/idb.ts";
import { PINCH_MAX_PT, PINCH_MIN_PT } from "./pinch-font.ts";

const KEY = "terminal-pinch-font-size";

const valid = (stored: unknown): number | null =>
  typeof stored === "number" && stored >= PINCH_MIN_PT && stored <= PINCH_MAX_PT ? stored : null;

/**
 * The terminal size this device was pinched to, over its configured default (Settings > Terminal keeps the default; a
 * two-finger double tap clears this). One value for the whole device, beside the terminal config in IndexedDB.
 */
export class PinchFontStore {
  #size: number | null = null;
  #listeners = new Set<() => void>();
  readonly #storage: KeyValueStore;
  readonly loaded: Promise<void>;

  constructor(storage: KeyValueStore) {
    this.#storage = storage;
    // An unreadable store leaves the default in force: the pinch still works for this load, it is just not kept.
    this.loaded = storage.get(KEY).then(
      (stored) => this.#set(valid(stored)),
      () => undefined,
    );
  }

  get size(): number | null {
    return this.#size;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  set(size: number): Promise<void> {
    this.#set(size);
    return this.#storage.put(KEY, size);
  }

  clear(): Promise<void> {
    this.#set(null);
    return this.#storage.put(KEY, null);
  }

  #set(size: number | null): void {
    this.#size = size;
    for (const listener of this.#listeners) listener();
  }
}

/** The config the terminals draw with: the pinched size, when there is one, in place of font-size. */
export function pinchedConfig(config: TerminalConfig, size: number | null): TerminalConfig {
  return size === null ? config : withValues(config, "font-size", [String(size)]);
}

/**
 * A size chosen in Settings or with the zoom keys is the person asking for that size now: the pinched one gives way to
 * it, or the change would not show.
 */
export function followConfiguredSize(pinch: PinchFontStore, config: TerminalConfigStore): () => void {
  let configured = single(config.config, "font-size");
  return config.subscribe(() => {
    const next = single(config.config, "font-size");
    if (next === configured) return;
    configured = next;
    if (pinch.size !== null) void pinch.clear();
  });
}

export const pinchFontStore = new PinchFontStore(typeof indexedDB === "undefined" ? memoryStore() : deviceStore);
// The configured size is read once loaded, so the stored value arriving is no change.
void terminalConfigStore.loaded.then(() => followConfiguredSize(pinchFontStore, terminalConfigStore));

export function usePinchFontSize(store: PinchFontStore = pinchFontStore): number | null {
  return useSyncExternalStore(store.subscribe, () => store.size);
}
