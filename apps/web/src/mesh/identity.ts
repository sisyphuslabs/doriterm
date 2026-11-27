import { concatBytes, hostIdOf, type StaticKey } from "@doriface/crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { type CardKey, readOrCreateCardKey, storedKey } from "../connection/card-key.ts";
import {
  forgetCachedDeviceKey,
  forgetDeviceKey,
  isStored,
  readOrCreateDeviceKey,
  withIdentityLock,
} from "../connection/device-key.ts";
import { deviceStore, type KeyValueStore } from "../storage/idb.ts";
import { authorityOf, checkedSigner, checkedStatic } from "../storage/key-authority.ts";

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

/**
 * Both keys share the existing device lock; migration keeps the paired Noise key and the original signing key. A store
 * governed by a slot's authority (`slotKeys`) is asked first, so a slot that may not act gets no keys at all, and the
 * keys handed out re-check that authority on every use, cached or not (review of #2890).
 */
export async function loadBrowserIdentity(
  storage: KeyValueStore = deviceStore,
  subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null,
): Promise<BrowserIdentity> {
  const authority = authorityOf(storage);
  if (authority === undefined) return loadCachedIdentity(storage, subtle);
  const grant = await authority();
  const halves = (held: BrowserIdentity) => ({
    "device-key": held.device.publicKey,
    "mesh-sign-key": held.card.publicKey,
  });
  let identity = await loadCachedIdentity(storage, subtle);
  // A cached load is used only when its keys are still the slot's stored keys; otherwise it is dropped and read again.
  if (!(await grant.current(halves(identity)))) {
    forgetCachedIdentity(storage);
    identity = await loadCachedIdentity(storage, subtle);
  }
  await grant.bind(halves(identity));
  return { device: checkedStatic(identity.device, grant), card: checkedSigner(identity.card, grant) };
}

function loadCachedIdentity(storage: KeyValueStore, subtle: SubtleCrypto | null): Promise<BrowserIdentity> {
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

/** Deletes both keys and both probes, which hold generated private keys too (review of #2890), and the cached loads. */
export async function resetBrowserIdentity(storage: KeyValueStore = deviceStore): Promise<void> {
  await pending.get(storage)?.catch(() => undefined);
  await withIdentityLock(async () => {
    await Promise.all([storage.put("mesh-sign-key", null), storage.put("mesh-sign-key.probe", null)]);
    await Promise.all([forgetDeviceKey(storage), storage.put("device-key.probe", null)]);
    pending.delete(storage);
  });
}

/** Another tab retired this identity: drop what this page holds of it, without touching storage. */
export function forgetCachedIdentity(storage: KeyValueStore): void {
  pending.delete(storage);
  forgetCachedDeviceKey(storage);
}

const encoder = new TextEncoder();

/** Retained for consumers of the first browser membership release. */
export const clientIdOf = (signPub: Uint8Array): string =>
  bytesToHex(sha256(concatBytes(encoder.encode("doriface-client/1"), signPub)).subarray(0, 16));

export function memberIdentityOf(sign: Pick<CardKey, "publicKey">, noisePub: Uint8Array) {
  return { hostId: hostIdOf(sign.publicKey), sign, noisePub };
}
