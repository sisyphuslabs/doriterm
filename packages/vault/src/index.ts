export {
  type DeviceKey,
  type HolderMemory,
  holderMemory,
  type StrangerMemory,
  strangerMemory,
  type KeyProtection,
  type MemberSigner,
  type VaultContext,
} from "./context.ts";
export { EMPTY_VAULT, mergeVaults, parseVaultDoc, VAULT_DOC, type VaultDoc } from "./doc.ts";
export { type EntryDraft, type Keyholder, localKeyholder, type TierHandle } from "./keyholder.ts";
export { type KeyholderRequest, remoteKeyholder, serveKeyholder } from "./keyholder-rpc.ts";
export type { DeviceBody, SignedRecord } from "./records.ts";
export { openersOf, type ResolvedTier, type ResolvedVault } from "./resolve.ts";
export { type EntryRead, maintain, readEntry, resolveVault, writeEntry } from "./vault.ts";
