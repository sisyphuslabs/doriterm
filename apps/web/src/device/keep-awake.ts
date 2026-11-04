import { useEffect, useSyncExternalStore } from "react";
import { ScreenAwake, type ScreenWakeLock } from "./wake-lock.ts";

const KEY = "doriface.device.keep-awake";

/** The browser's Screen Wake Lock, or null where it has none (an older Safari, Firefox before 126). */
export function screenWakeLock(scope: object = globalThis.navigator): ScreenWakeLock | null {
  const lock: unknown = Reflect.get(scope, "wakeLock");
  return typeof lock === "object" && lock !== null && typeof Reflect.get(lock, "request") === "function"
    ? {
        request: (type) => Reflect.apply(Reflect.get(lock, "request"), lock, [type]),
      }
    : null;
}

/** Off unless stored as on; storage that refuses the read leaves it off, so the app still starts. */
function storedKeepAwake(): boolean {
  try {
    return localStorage.getItem(KEY) === "true";
  } catch {
    return false;
  }
}

class KeepAwakeStore {
  #value = storedKeepAwake();
  #listeners = new Set<() => void>();
  get value(): boolean {
    return this.#value;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  set(value: boolean): void {
    this.#value = value;
    localStorage.setItem(KEY, String(value));
    for (const listener of this.#listeners) listener();
  }
}

export const keepAwakeStore = new KeepAwakeStore();

export function useKeepAwake(): boolean {
  return useSyncExternalStore(keepAwakeStore.subscribe, () => keepAwakeStore.value);
}

const lock = screenWakeLock();
const awake = lock === null ? null : new ScreenAwake(lock, document);
let screens = 0;
const sync = (): void => void awake?.want(keepAwakeStore.value && screens > 0);
keepAwakeStore.subscribe(sync);

/** Marks a terminal as on screen for as long as the calling component is mounted, so the screen stays awake. */
export function useScreenAwake(): void {
  useEffect(() => {
    screens += 1;
    sync();
    return () => {
      screens -= 1;
      sync();
    };
  }, []);
}
