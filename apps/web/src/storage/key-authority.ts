import type { KeyValueStore } from "./idb.ts";

export type KeyName = "device-key" | "mesh-sign-key";
/** The public halves of keys a loader holds, by the name they are stored under. */
export type PublicHalves = { readonly [Name in KeyName]?: Uint8Array };

/**
 * What a loaded key may do, read from storage when it is loaded and on every use (`mesh/slot-authority.ts`). The check
 * is tied to the key itself: a use is refused unless the key the loader holds is still the very key stored and recorded
 * for the slot's current lifecycle, so a key from a cache of any context (a page, the service worker) that a leave did
 * not reach can never pass under a later lifecycle (review of #2890).
 */
export interface KeyGrant {
  /** Runs before each use of the key named `name` whose public half is `publicKey`; rejects when it may not be used. */
  readonly check: (name: KeyName, publicKey: Uint8Array) => Promise<void>;
  /** Whether keys a loader holds (perhaps from its cache) are the slot's keys now; a loader reloads when not. */
  readonly current: (keys: PublicHalves) => Promise<boolean>;
  /** Records the loaded keys' public halves with the lifecycle on its first load, and refuses any other keys after. */
  readonly bind: (keys: PublicHalves) => Promise<void>;
}

export type KeyAuthority = () => Promise<KeyGrant>;

const authorities = new WeakMap<KeyValueStore, KeyAuthority>();

/** Ties a key store to the authority over the identity whose keys it holds; the loaders ask it on every load. */
export function governKeys(store: KeyValueStore, authority: KeyAuthority): void {
  authorities.set(store, authority);
}

export const authorityOf = (store: KeyValueStore): KeyAuthority | undefined => authorities.get(store);

/** A Noise static key whose every DH is checked first; a handshake in flight stops at its next one. */
export const checkedStatic = <K extends { readonly publicKey: Uint8Array; dh(peer: Uint8Array): Promise<Uint8Array> }>(
  key: K,
  grant: KeyGrant,
): K => ({
  ...key,
  dh: async (peer: Uint8Array) => {
    await grant.check("device-key", key.publicKey);
    return key.dh(peer);
  },
});

export const checkedSigner = <
  K extends { readonly publicKey: Uint8Array; sign(message: Uint8Array): Promise<Uint8Array> },
>(
  key: K,
  grant: KeyGrant,
): K => ({
  ...key,
  sign: async (message: Uint8Array) => {
    await grant.check("mesh-sign-key", key.publicKey);
    return key.sign(message);
  },
});
