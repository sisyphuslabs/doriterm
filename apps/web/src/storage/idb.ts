/**
 * A tiny promise wrapper over one IndexedDB object store. Where IndexedDB is unavailable or denied its
 * calls reject; the settings stores then show the error and refuse writes, and the device key fails,
 * because a key that is not stored would give the device a new identity on every load.
 */
export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

const DB = "doriface";
const STORE = "device";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.addEventListener("success", () => resolve(req.result));
    req.addEventListener("error", () => reject(req.error ?? new Error("IndexedDB request failed")));
  });
}

/** A write is stored only once its transaction commits; a request's success can still be rolled back. */
function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    // abort always follows a failed write, with transaction.error set; an earlier error event may not have it yet.
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("IndexedDB transaction did not commit")),
    );
  });
}

let opened: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.addEventListener("upgradeneeded", () => req.result.createObjectStore(STORE));
    req.addEventListener("success", () => resolve(req.result));
    req.addEventListener("error", () => reject(req.error ?? new Error("cannot open IndexedDB")));
  });
  // A failed open is not remembered: the next call opens again.
  opened.catch(() => {
    opened = null;
  });
  return opened;
}

/** Per-device storage. Values are structured-cloned, so CryptoKey objects survive non-extractable. */
export const deviceStore: KeyValueStore = {
  async get(key) {
    const db = await open();
    return request(db.transaction(STORE).objectStore(STORE).get(key));
  },
  async put(key, value) {
    const db = await open();
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(value, key);
    await committed(transaction);
  },
};

/** Whether a failed write failed because this store cannot structured-clone the value at all. */
export function refusesToClone(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "DataCloneError";
}

export function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>();
  return {
    get: async (key) => values.get(key),
    put: async (key, value) => {
      values.set(key, value);
    },
  };
}
