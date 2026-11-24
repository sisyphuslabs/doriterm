export type StorageKeeping = "kept" | "best-effort" | "unsupported";

type StorageManagerLike = Pick<StorageManager, "persisted" | "persist">;

const browserManager = (): StorageManagerLike | undefined =>
  typeof navigator === "undefined" ? undefined : navigator.storage;

/**
 * Asks the browser to keep this origin's storage, which holds the device key (IndexedDB) and the paired hosts
 * (localStorage). Without it the storage is best-effort, and iOS clears a Home Screen app's data with it, so the app
 * starts as a new, unpaired device (#2759).
 */
export async function keepStorage(manager: StorageManagerLike | undefined = browserManager()): Promise<StorageKeeping> {
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
 * started as a device paired long ago.
 */
export function keepStorageOnceOpen(
  store: OpeningStore,
  keep: () => Promise<StorageKeeping> = () => keepStorage(),
): void {
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
