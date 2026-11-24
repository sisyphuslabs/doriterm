import { ipcMain } from "electron";
import { VaultChannel } from "../shared/vault.ts";
import { type VaultDeps, vaultHandlers } from "./ipc-vault-handlers.ts";

export type { VaultDeps } from "./ipc-vault-handlers.ts";

export function registerVaultIpc(deps: VaultDeps): void {
  const handlers = vaultHandlers(deps);
  ipcMain.handle(VaultChannel.recipient, (event) => handlers.recipient(event));
  ipcMain.handle(VaultChannel.protection, (event) => handlers.protection(event));
  ipcMain.handle(VaultChannel.unseal, (event, candidate: unknown) => handlers.unseal(event, candidate));
}
