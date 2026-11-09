import { concatBytes, hostIdOf, type StaticKey } from "@doriface/crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { type CardKey, readOrCreateCardKey, storedKey } from "../connection/card-key.ts";
import { forgetDeviceKey, isStored, readOrCreateDeviceKey, withIdentityLock } from "../connection/device-key.ts";
import { deviceStore, type KeyValueStore } from "../storage/idb.ts";

export interface BrowserIdentity {
  readonly device: StaticKey;
  readonly card: CardKey;
}

const pending = new WeakMap<KeyValueStore, Promise<BrowserIdentity>>();

/** Check surviving private material before a connection or join is allowed to generate replacement keys. */
export function hasBrowserIdentity(storage: KeyValueStore = deviceStore): Promise<boolean> {
  return withIdentityLock(async () => {
    if (!isStored(await storage.get("device-key"))) return false;
    const sign = await storage.get("mesh-sign-key");
    if (storedKey(sign)) return true;
    if (typeof sign !== "object" || sign === null || Reflect.get(sign, "kind") !== "ed25519") return false;
    const secretKey: unknown = Reflect.get(sign, "secretKey");
    return secretKey instanceof Uint8Array && secretKey.length === 32;
  });
}

/** Both keys share the existing device lock; migration keeps the paired Noise key and the original signing key. */
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

/** A signing capability, never an exported WebCrypto private key. */
export async function loadSignKey(
  storage: KeyValueStore = deviceStore,
  subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null,
): Promise<CardKey> {
  return (await loadBrowserIdentity(storage, subtle)).card;
}

export async function resetBrowserIdentity(storage: KeyValueStore = deviceStore): Promise<void> {
  await pending.get(storage);
  await withIdentityLock(async () => {
    await storage.put("mesh-sign-key", null);
    await forgetDeviceKey(storage);
    pending.delete(storage);
  });
}

const encoder = new TextEncoder();

/** Retained for consumers of the first browser membership release. */
export const clientIdOf = (signPub: Uint8Array): string =>
  bytesToHex(sha256(concatBytes(encoder.encode("doriface-client/1"), signPub)).subarray(0, 16));

export function memberIdentityOf(sign: Pick<CardKey, "publicKey">, noisePub: Uint8Array) {
  return { hostId: hostIdOf(sign.publicKey), sign, noisePub };
}
