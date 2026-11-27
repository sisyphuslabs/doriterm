import { useSyncExternalStore } from "react";

export type StorageKeeping = "kept" | "best-effort" | "unsupported";

type StorageManagerLike = Pick<StorageManager, "persisted" | "persist">;

/** The browser's last answer about keeping this origin's storage; null until the app has asked once. */
class KeepingStore {
  #value: StorageKeeping | null = null;
  #listeners = new Set<() => void>();
  get value(): StorageKeeping | null {
    return this.#value;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  set(value: StorageKeeping): void {
    if (value === this.#value) return;
    this.#value = value;
    for (const listener of this.#listeners) listener();
  }
}

export const storageKeepingStore = new KeepingStore();

/** Settings shows whether the browser keeps this app's storage, so a phone that may clear it says so up front. */
export function useStorageKeeping(): StorageKeeping | null {
  return useSyncExternalStore(storageKeepingStore.subscribe, () => storageKeepingStore.value);
}

const browserManager = (): StorageManagerLike | undefined =>
  typeof navigator === "undefined" ? undefined : navigator.storage;

/**
 * Asks the browser to keep this origin's storage, which holds the device key (IndexedDB) and the paired hosts
 * (localStorage). Without it the storage is best-effort, and iOS clears a Home Screen app's data with it, so the app
 * starts as a new, unpaired device (#2759).
 */
export async function keepStorage(
  manager: StorageManagerLike | undefined = browserManager(),
  store: KeepingStore = storageKeepingStore,
): Promise<StorageKeeping> {
  const result = await askToKeep(manager);
  store.set(result);
  return result;
}

async function askToKeep(manager: StorageManagerLike | undefined): Promise<StorageKeeping> {
  if (manager?.persisted === undefined || manager.persist === undefined) return "unsupported";
  if (await manager.persisted()) return "kept";
  return (await manager.persist()) ? "kept" : "best-effort";
}

interface OpeningStore {
  readonly state: { readonly phase: string };
  subscribe(listener: () => void): () => void;
}

/**
 * Asks to keep storage each time `store` opens a connection, until the browser keeps it. An open connection is the
 * moment a device has proved it holds an identity worth keeping, whether it paired with a code, joined a mesh or
 * started as a device paired long ago. A launch that holds one asks as soon as the store leaves unconfigured, before
 * any connection opens: iOS grants the request by its own heuristic and can still clear a Home Screen app's storage
 * (Q's phone re-paired five times in three weeks), so every launch asks again and Settings shows the answer.
 */
export function keepStorageOnceOpen(
  store: OpeningStore,
  keep: () => Promise<StorageKeeping> = () => keepStorage(),
): void {
  let askedAtLaunch = false;
  const askAtLaunch = (): void => {
    if (askedAtLaunch || store.state.phase === "unconfigured") return;
    askedAtLaunch = true;
    void keep().catch(() => undefined);
  };
  askAtLaunch();
  const unsubscribeLaunch = store.subscribe(() => {
    askAtLaunch();
    if (askedAtLaunch) unsubscribeLaunch();
  });
  let wasOpen = false;
  const stop = store.subscribe(() => {
    const open = store.state.phase === "open";
    if (open && !wasOpen) {
      void keep().then(
        (result) => (result === "best-effort" ? undefined : stop()),
        () => undefined,
      );
    }
    wasOpen = open;
  });
}
