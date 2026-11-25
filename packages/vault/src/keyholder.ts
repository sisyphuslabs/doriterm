import {
  decodeSecretKey,
  type Envelope,
  type EntryPayload,
  fromUtf8,
  generateSecretKey,
  openEntry,
  type PublicKey,
  publicKeyOf,
  samePublic,
  type SecretKey,
  sealEntry,
  sealWrap,
  signerOf,
  TypeVaultError,
  type VaultState,
} from "typevault/core";
import type { DeviceKey, KeyProtection } from "./context.ts";

export const TIER = "mesh";

/** Mesh vault entries are signed by the tier key, never by a TypeVault grant: a grant-signed entry is refused. */
const NO_GRANTS = (): boolean => false;

export interface EntryDraft {
  readonly id: string;
  readonly rev: number;
  readonly at: string;
  readonly payload: EntryPayload;
}

/**
 * The use of one tier key without handing out its bytes: open an entry, seal one, seal the key to a recipient. Every
 * method runs where the key is held (the desktop main process, the browser's vault worker). This keeps the key out of
 * the page's memory; it is not a boundary against script in the app origin, which can wrap the key to a recipient of
 * its own (see #2828 for the desktop fix and #2791 for the threat model).
 */
export interface TierHandle {
  readonly gen: number;
  readonly publicKey: PublicKey;
  /** The entry's payload, or undefined when it is not this key's or cannot be read. */
  open(envelope: Envelope): Promise<EntryPayload | undefined>;
  seal(draft: EntryDraft): Promise<Envelope>;
  wrapFor(recipient: string): Promise<Uint8Array>;
}

/** This device's vault key and the tier keys it opened, behind one boundary. */
export interface Keyholder {
  readonly recipient: string;
  readonly protection: KeyProtection;
  /** The tier key sealed in `sealed`, only when it is exactly `expected` for `gen`; undefined for anything else. */
  unwrap(sealed: Uint8Array, gen: number, expected: PublicKey): Promise<TierHandle | undefined>;
  /** A new tier key for `gen`, created and kept on this side. */
  generate(gen: number): Promise<TierHandle>;
}

/** The TypeVault state an envelope is checked against: one tier, whose key also stands in as the owner key. */
export const stateFor = (gen: number, publicKey: PublicKey): VaultState => ({
  owner: publicKey,
  origin: `${TIER}:${gen}`,
  handovers: [],
  seqs: { tiers: gen, members: 1, signers: 1, ceilings: 1 },
  tiers: { [TIER]: { includes: [], gen, ...publicKey } },
  members: {},
  signers: {},
  ceilings: {},
});

const quietly = <T>(cause: unknown): T | undefined => {
  if (cause instanceof TypeVaultError) return undefined;
  throw cause;
};

async function handleOf(key: SecretKey, gen: number): Promise<TierHandle> {
  const publicKey = await publicKeyOf(key);
  const state = stateFor(gen, publicKey);
  const unlock = async (tier: string) => (tier === TIER ? key : undefined);
  return {
    gen,
    publicKey,
    open: (envelope) =>
      envelope.tier !== TIER || envelope.gen !== gen
        ? Promise.resolve(undefined)
        : openEntry(envelope, { unlock }, NO_GRANTS).catch(quietly<EntryPayload>),
    seal: (draft) => sealEntry({ ...draft, tier: TIER }, state, signerOf(key)),
    wrapFor: (recipient) => sealWrap(key, [recipient]),
  };
}

/** A keyholder over a device key, for the worker or the main process: its tier keys are never returned as bytes. */
export function localKeyholder(device: DeviceKey): Keyholder {
  return {
    recipient: device.recipient,
    protection: device.protection,
    async unwrap(sealed, gen, expected) {
      const bytes = await device.unseal(sealed).catch(quietly<Uint8Array>);
      if (bytes === undefined) return undefined;
      const key = (() => {
        try {
          return decodeSecretKey(fromUtf8(bytes));
        } catch (cause) {
          return quietly<SecretKey>(cause);
        }
      })();
      if (key === undefined) return undefined;
      const { role } = key;
      if (role.kind !== "tier" || role.tier !== TIER || role.gen !== gen) return undefined;
      if (!samePublic(await publicKeyOf(key), expected)) return undefined;
      return handleOf(key, gen);
    },
    generate: async (gen) => handleOf(await generateSecretKey({ kind: "tier", tier: TIER, gen }), gen),
  };
}
