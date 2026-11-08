import { deviceStore, type KeyValueStore } from "../storage/idb.ts";
import { type CardKey, readOrCreateCardKey } from "./card-key.ts";
import { type DeviceKey, forgetDeviceKey, readOrCreateDeviceKey, withIdentityLock } from "./device-key.ts";

export interface BrowserIdentity {
  readonly device: DeviceKey;
  readonly card: CardKey;
}

const pending = new WeakMap<KeyValueStore, Promise<BrowserIdentity>>();

/** A migrated pairing keeps its device key; a fresh browser creates both keys under the same Web Lock. */
export function loadBrowserIdentity(
  storage: KeyValueStore = deviceStore,
  subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null,
): Promise<BrowserIdentity> {
  const held = pending.get(storage);
  if (held !== undefined) return held;
  const loading = withIdentityLock(async () => ({
    device: await readOrCreateDeviceKey(storage, subtle),
    card: await readOrCreateCardKey(storage, subtle),
  }));
  pending.set(storage, loading);
  loading.catch(() => pending.delete(storage));
  return loading;
}

/** Leave and Join again must discard both keys, including values cached by this page. */
export async function resetBrowserIdentity(storage: KeyValueStore = deviceStore): Promise<void> {
  await pending.get(storage);
  await withIdentityLock(async () => {
    await storage.put("card-key", null);
    await forgetDeviceKey(storage);
    pending.delete(storage);
  });
}
