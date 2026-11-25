import type { RevisionLedger } from "typevault/core";
import type { Keyholder } from "./keyholder.ts";

/** Where a device's vault key lives, from the weakest to the strongest custody the platform offers. */
export type KeyProtection = "unprotected" | "non-extractable" | "os-keystore";

/**
 * This device's vault key (an age X25519 identity). The private half stays with its custodian: a non-extractable
 * WebCrypto key in a browser, the desktop main process behind the OS key store. `unseal` rejects with a TypeVaultError
 * `denied` when the ciphertext is not sealed to this key.
 */
export interface DeviceKey {
  readonly recipient: string;
  readonly protection: KeyProtection;
  unseal(sealed: Uint8Array): Promise<Uint8Array>;
}

/** This member's mesh signing key (base64url Ed25519 public half); the private half never leaves its store. */
export interface MemberSigner {
  readonly signPub: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/**
 * The holders this device has seen wrapped in a generation (by a member's signature). Kept on the device, so a machine
 * that later drops a wrap from the document cannot make this device forget a holder it must rotate away from.
 */
export interface HolderMemory {
  holders(tier: string): ReadonlySet<string>;
  remember(tier: string, holders: Iterable<string>): void;
}

/** A holder memory over a plain record (tier record id -> holder signPubs), for a store to persist with `snapshot`. */
export function holderMemory(initial: Readonly<Record<string, readonly string[]>> = {}) {
  const seen = new Map(Object.entries(initial).map(([tier, holders]) => [tier, new Set(holders)]));
  return {
    holders: (tier: string): ReadonlySet<string> => seen.get(tier) ?? new Set(),
    remember(tier: string, holders: Iterable<string>): void {
      const kept = seen.get(tier) ?? new Set<string>();
      for (const holder of holders) kept.add(holder);
      seen.clear();
      seen.set(tier, kept);
    },
    snapshot: (): Record<string, string[]> =>
      Object.fromEntries([...seen].map(([tier, holders]) => [tier, [...holders]])),
  };
}

export interface VaultContext {
  readonly mesh: string;
  /** signPubs of the current members, from the verified mesh records (never the advisory status document). */
  readonly members: ReadonlySet<string>;
  readonly self: MemberSigner;
  /** This device's vault key and the tier keys it opens; the tier keys never leave it. */
  readonly key: Keyholder;
  /** The highest entry revision and tier generation this device has seen; a lower one handed over is a rollback. */
  readonly ledger: RevisionLedger;
  readonly memory: HolderMemory;
  readonly now: () => string;
}
