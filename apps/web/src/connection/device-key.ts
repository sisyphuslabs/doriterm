import { x25519 } from "@noble/curves/ed25519.js";
import { deviceStore, refusesToClone, type KeyValueStore } from "../storage/idb.ts";

/** The device's X25519 static key: its public half plus the DH the Noise handshake needs. */
export interface DeviceKey {
  readonly publicKey: Uint8Array;
  readonly kind: "webcrypto" | "raw";
  dh(peerPublic: Uint8Array): Promise<Uint8Array>;
}

const KEY = "device-key";
const ALGORITHM = { name: "X25519" } as const;

type StoredWebCrypto = { readonly kind: "webcrypto"; readonly privateKey: CryptoKey; readonly publicKey: Uint8Array };
type StoredRaw = { readonly kind: "raw"; readonly privateKey: Uint8Array };

export function isStored(value: unknown): value is StoredWebCrypto | StoredRaw {
  if (typeof value !== "object" || value === null) return false;
  const kind: unknown = Reflect.get(value, "kind");
  const privateKey: unknown = Reflect.get(value, "privateKey");
  if (kind === "raw") return privateKey instanceof Uint8Array && privateKey.length === 32;
  return (
    kind === "webcrypto" && privateKey instanceof CryptoKey && Reflect.get(value, "publicKey") instanceof Uint8Array
  );
}

function isKeyPair(value: CryptoKey | CryptoKeyPair): value is CryptoKeyPair {
  return "privateKey" in value && "publicKey" in value;
}

async function importPeer(subtle: SubtleCrypto, peerPublic: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey("raw", Uint8Array.from(peerPublic), ALGORITHM, false, []);
}

async function fromWebCrypto(subtle: SubtleCrypto, stored: StoredWebCrypto): Promise<DeviceKey> {
  return {
    publicKey: stored.publicKey,
    kind: "webcrypto",
    dh: async (peerPublic) =>
      new Uint8Array(
        await subtle.deriveBits(
          { name: "X25519", public: await importPeer(subtle, peerPublic) },
          stored.privateKey,
          256,
        ),
      ),
  };
}

function fromRaw(stored: StoredRaw): DeviceKey {
  return {
    publicKey: x25519.getPublicKey(stored.privateKey),
    kind: "raw",
    dh: async (peerPublic) => x25519.getSharedSecret(stored.privateKey, peerPublic),
  };
}

/** True when this browser can generate and derive with X25519 CryptoKeys. */
export async function webCryptoX25519(subtle: SubtleCrypto | null): Promise<boolean> {
  if (subtle === null) return false;
  try {
    const pair = await subtle.generateKey(ALGORITHM, false, ["deriveBits"]);
    return isKeyPair(pair);
  } catch {
    return false;
  }
}

async function generateWebCrypto(subtle: SubtleCrypto): Promise<StoredWebCrypto> {
  const pair = await subtle.generateKey(ALGORITHM, false, ["deriveBits"]);
  if (!isKeyPair(pair)) throw new Error("X25519 generateKey returned no key pair");
  const publicKey = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return { kind: "webcrypto", privateKey: pair.privateKey, publicKey };
}

const PROBE = "device-key.probe";
const keepsKeys = new WeakMap<KeyValueStore, Promise<boolean>>();

/**
 * Whether this store gives a stored CryptoKey back. WebKit's IndexedDB hands an X25519 CryptoKey back as null
 * (bugs.webkit.org 312279), and some WebKit builds refuse to clone it at write time with a DataCloneError (#1634);
 * either way the key must be kept as bytes there or the device is new on every load (#1329).
 *
 * Any other failure (busy, quota, abort) says nothing about whether it can keep a CryptoKey, so it is raised rather
 * than read as "this browser cannot": answering false there would quietly drop a working browser to raw bytes.
 */
async function keepsStoredKeys(storage: KeyValueStore, subtle: SubtleCrypto): Promise<boolean> {
  const held = keepsKeys.get(storage);
  if (held !== undefined) return held;
  const probe = (async (): Promise<boolean> => {
    const pair = await generateWebCrypto(subtle);
    try {
      await storage.put(PROBE, pair);
    } catch (cause) {
      if (refusesToClone(cause)) return false;
      throw cause;
    }
    const back = await storage.get(PROBE);
    return isStored(back) && back.kind === "webcrypto";
  })();
  keepsKeys.set(storage, probe);
  try {
    return await probe;
  } catch (cause) {
    keepsKeys.delete(storage);
    throw cause;
  }
}

export async function readOrCreateDeviceKey(storage: KeyValueStore, subtle: SubtleCrypto | null): Promise<DeviceKey> {
  const stored = await storage.get(KEY);
  if (isStored(stored))
    return stored.kind === "webcrypto" && subtle !== null ? fromWebCrypto(subtle, stored) : fromRaw(asRaw(stored));
  if (subtle !== null && (await webCryptoX25519(subtle)) && (await keepsStoredKeys(storage, subtle))) {
    const generated = await generateWebCrypto(subtle);
    await storage.put(KEY, generated);
    return fromWebCrypto(subtle, generated);
  }
  const generated: StoredRaw = { kind: "raw", privateKey: x25519.utils.randomSecretKey() };
  await storage.put(KEY, generated);
  return fromRaw(generated);
}

const pending = new WeakMap<KeyValueStore, Promise<DeviceKey>>();
const LOCK = "doriface-device-key";

/** Serializes device and card custody together, including first join and local identity removal. */
export async function withIdentityLock<T>(action: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  return locks === undefined ? action() : locks.request(LOCK, action);
}

export async function forgetDeviceKey(storage: KeyValueStore): Promise<void> {
  await storage.put(KEY, null);
  pending.delete(storage);
}

/**
 * Loads the device key, generating it on first use. The private half is a non-extractable
 * CryptoKey when WebCrypto has X25519, else 32 raw bytes; either survives in IndexedDB by structured clone.
 * Concurrent first calls share one creation: per store in this page, and across tabs through the Web
 * Locks API where it exists, re-reading the store inside the lock so a second tab gets the first's key.
 */
export function loadDeviceKey(
  storage: KeyValueStore = deviceStore,
  subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null,
): Promise<DeviceKey> {
  const inFlight = pending.get(storage);
  if (inFlight !== undefined) return inFlight;
  const loading = withIdentityLock(() => readOrCreateDeviceKey(storage, subtle));
  pending.set(storage, loading);
  // A failure is not remembered: the next call tries the store again.
  loading.catch(() => pending.delete(storage));
  return loading;
}

function asRaw(stored: StoredWebCrypto | StoredRaw): StoredRaw {
  if (stored.kind === "raw") return stored;
  throw new Error("the stored device key needs WebCrypto X25519, which this browser no longer offers");
}
