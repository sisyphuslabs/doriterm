import type { KeyValueStore } from "./idb.ts";

/** Resolves when the identity a key belongs to may still use that key now, and rejects when it may not. */
export type KeyCheck = (key: "device-key" | "mesh-sign-key") => Promise<void>;
/** Reads, when a key is loaded, which identity it belongs to, and returns the check every later use runs. */
export type KeyAuthority = () => Promise<KeyCheck>;

const authorities = new WeakMap<KeyValueStore, KeyAuthority>();

/**
 * Ties a key store to the authority over the identity whose keys it holds (`mesh/slot-authority.ts`). The loaders ask
 * it once per load and wrap the keys they return, so every use re-checks storage itself: a key loaded before its mesh
 * was left, held in a cache or in an operation already running, cannot be used after (review of #2890).
 */
export function governKeys(store: KeyValueStore, authority: KeyAuthority): void {
  authorities.set(store, authority);
}

export const authorityOf = (store: KeyValueStore): KeyAuthority | undefined => authorities.get(store);

/** A Noise static key whose every DH is checked first; a handshake in flight stops at its next one. */
export const checkedStatic = <K extends { dh(peer: Uint8Array): Promise<Uint8Array> }>(key: K, check: KeyCheck): K => ({
  ...key,
  dh: async (peer: Uint8Array) => {
    await check("device-key");
    return key.dh(peer);
  },
});

export const checkedSigner = <K extends { sign(message: Uint8Array): Promise<Uint8Array> }>(
  key: K,
  check: KeyCheck,
): K => ({
  ...key,
  sign: async (message: Uint8Array) => {
    await check("mesh-sign-key");
    return key.sign(message);
  },
});
