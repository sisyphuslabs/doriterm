import type { RevisionLedger } from "typevault/core";

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

export interface VaultContext {
  readonly mesh: string;
  /** signPubs of the current members, from the verified mesh records (never the advisory status document). */
  readonly members: ReadonlySet<string>;
  readonly self: MemberSigner;
  readonly key: DeviceKey;
  /** The highest entry revision and tier generation this device has seen; a lower one handed over is a rollback. */
  readonly ledger: RevisionLedger;
  readonly now: () => string;
}
