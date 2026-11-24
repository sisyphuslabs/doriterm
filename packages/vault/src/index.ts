export type { DeviceKey, KeyProtection, MemberSigner, VaultContext } from "./context.ts";
export { EMPTY_VAULT, mergeVaults, parseVaultDoc, VAULT_DOC, type VaultDoc } from "./doc.ts";
export type { DeviceBody, SignedRecord } from "./records.ts";
export type { ResolvedTier, ResolvedVault } from "./resolve.ts";
export { type EntryRead, maintain, readEntry, resolveVault, writeEntry } from "./vault.ts";
