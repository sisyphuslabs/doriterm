import { ipcMain } from "electron";
import { VaultChannel } from "../shared/vault.ts";
import { type VaultDeps, vaultHandlers } from "./ipc-vault-handlers.ts";

export type { VaultDeps } from "./ipc-vault-handlers.ts";

export function registerVaultIpc(deps: VaultDeps): void {
  const handlers = vaultHandlers(deps);
  ipcMain.handle(VaultChannel.keyholder, (event, request: unknown) => handlers.keyholder(event, request));
}
