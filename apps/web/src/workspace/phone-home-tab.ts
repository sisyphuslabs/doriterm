import { useSyncExternalStore } from "react";
import { guardedLocalStorage } from "../storage/guarded.ts";

/** The list the phone home shows; Settings is a route, not a list, so it is not one of these. */
export type PhoneHomeTab = "agents" | "spaces";

export const PHONE_HOME_KEY = "doriface.phone-home";

export function loadPhoneHomeTab(storage: Pick<Storage, "getItem"> = guardedLocalStorage()): PhoneHomeTab {
  return storage.getItem(PHONE_HOME_KEY) === "spaces" ? "spaces" : "agents";
}

class PhoneHomeTabStore {
  #value: PhoneHomeTab = loadPhoneHomeTab();
  #listeners = new Set<() => void>();
  get value(): PhoneHomeTab {
    return this.#value;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  set(next: PhoneHomeTab): void {
    if (next === this.#value) return;
    this.#value = next;
    try {
      guardedLocalStorage().setItem(PHONE_HOME_KEY, next);
    } finally {
      for (const listener of this.#listeners) listener();
    }
  }
}

const store = new PhoneHomeTabStore();

/** The phone home's tab, kept per device so the phone opens where it was left (#1387). */
export function usePhoneHomeTab(): readonly [PhoneHomeTab, (next: PhoneHomeTab) => void] {
  const value = useSyncExternalStore(store.subscribe, () => store.value);
  return [value, (next) => store.set(next)];
}
