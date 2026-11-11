import { ipcMain } from "electron";
import { Channel } from "../shared/bridge.ts";
import { type UpdateDeps, updateHandlers } from "./ipc-update-handlers.ts";

export type { UpdateDeps } from "./ipc-update-handlers.ts";

export function registerUpdateIpc(deps: UpdateDeps): void {
  const handlers = updateHandlers(deps);
  ipcMain.handle(Channel.updateStatus, (event) => handlers.status(event));
  ipcMain.handle(Channel.updateChannel, (event) => handlers.channel(event));
  ipcMain.handle(Channel.setUpdateChannel, (event, candidate: unknown) => handlers.setChannel(event, candidate));
  ipcMain.handle(Channel.checkForUpdates, (event) => handlers.check(event));
}
