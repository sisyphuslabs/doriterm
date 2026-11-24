/** Renderer to main: the mesh vault key the main process holds behind the OS key store. */
export const VaultChannel = {
  recipient: "doriface:vault-recipient",
  protection: "doriface:vault-protection",
  unseal: "doriface:vault-unseal",
} as const;
