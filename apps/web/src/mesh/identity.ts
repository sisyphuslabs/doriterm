import { concatBytes, hostIdOf, type KeyPair } from "@doriface/crypto";
import type { MemberIdentity } from "@doriface/mesh/join";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { deviceStore, type KeyValueStore } from "../storage/idb.ts";

const KEY = "mesh-sign-key";
const LOCK = "doriface-mesh-sign-key";

interface StoredSignKey {
  readonly kind: "ed25519";
  readonly secretKey: Uint8Array;
}

function isStored(value: unknown): value is StoredSignKey {
  if (typeof value !== "object" || value === null || Reflect.get(value, "kind") !== "ed25519") return false;
  const secretKey: unknown = Reflect.get(value, "secretKey");
  return secretKey instanceof Uint8Array && secretKey.length === 32;
}

const pairOf = (secretKey: Uint8Array): KeyPair => ({ publicKey: ed25519.getPublicKey(secretKey), secretKey });

async function readOrCreate(storage: KeyValueStore): Promise<KeyPair> {
  const stored = await storage.get(KEY);
  if (isStored(stored)) return pairOf(stored.secretKey);
  const created: StoredSignKey = { kind: "ed25519", secretKey: ed25519.utils.randomSecretKey() };
  await storage.put(KEY, created);
  return pairOf(created.secretKey);
}

const pending = new WeakMap<KeyValueStore, Promise<KeyPair>>();

/**
 * This browser's Ed25519 signing key, generated on first use: the key its member card is signed under and the name
 * every other member knows it by. Raw bytes in IndexedDB (WebCrypto has no Ed25519 everywhere, and a card must be
 * signable with @noble as the host's is); concurrent first calls share one creation, across tabs through the Web
 * Locks API where it exists, as the device key does.
 */
export function loadSignKey(storage: KeyValueStore = deviceStore): Promise<KeyPair> {
  const inFlight = pending.get(storage);
  if (inFlight !== undefined) return inFlight;
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  const loading = locks === undefined ? readOrCreate(storage) : locks.request(LOCK, () => readOrCreate(storage));
  pending.set(storage, loading);
  loading.catch(() => pending.delete(storage));
  return loading;
}

const encoder = new TextEncoder();

/**
 * The card's `hcId` for a browser, which runs no herdr core: 32 hex characters (a core id's shape), one per signing
 * key and stable across loads, domain-separated from the hostId that hashes the same key.
 */
export const clientIdOf = (signPub: Uint8Array): string =>
  bytesToHex(sha256(concatBytes(encoder.encode("doriface-client/1"), signPub)).subarray(0, 16));

/** The identity a browser signs its card with: its signing pair, and the device key it attests as its Noise static. */
export function memberIdentityOf(sign: KeyPair, noisePub: Uint8Array): MemberIdentity {
  return { hostId: hostIdOf(sign.publicKey), sign, noisePub };
}
