import { ipcMain } from "electron";
import { Channel } from "../shared/bridge.ts";
import { ipcHandlers, type IpcDeps } from "./ipc-handlers.ts";

export function registerIpc(deps: IpcDeps): void {
  const handlers = ipcHandlers(deps);
  ipcMain.handle(Channel.openExternal, (event, candidate: unknown) => handlers.openExternal(event, candidate));
  ipcMain.handle(Channel.openLink, (event, candidate: unknown) => handlers.openLink(event, candidate));
  ipcMain.handle(Channel.startLocalHost, (event) => handlers.startLocalHost(event));
  ipcMain.handle(Channel.pairOffer, (event, candidate: unknown) => handlers.pairOffer(event, candidate));
  ipcMain.handle(Channel.pairedDevices, (event) => handlers.pairedDevices(event));
  ipcMain.handle(Channel.revokeDevice, (event, candidate: unknown) => handlers.revokeDevice(event, candidate));
  ipcMain.handle(Channel.setWindowBackground, (event, candidate: unknown) =>
    handlers.setWindowBackground(event, candidate),
  );
  ipcMain.handle(Channel.closeWindow, (event) => handlers.closeWindow(event));
  ipcMain.handle(Channel.takePairingLink, (event) => handlers.takePairingLink(event));
  ipcMain.handle(Channel.setMenuKeys, (event, candidate: unknown) => handlers.setMenuKeys(event, candidate));
  ipcMain.handle(Channel.chooseHc, (event) => handlers.chooseHc(event));
  ipcMain.handle(Channel.takeUpdate, (event) => handlers.takeUpdate(event));
  ipcMain.handle(Channel.installUpdate, (event) => handlers.installUpdate(event));
  ipcMain.handle(Channel.installHc, (event) => handlers.installHc(event));
  ipcMain.handle(Channel.noticesSupported, (event) => handlers.noticesSupported(event));
  ipcMain.handle(Channel.noticePermission, (event) => handlers.noticePermission(event));
  ipcMain.handle(Channel.showNotice, (event, candidate: unknown) => handlers.showNotice(event, candidate));
  ipcMain.handle(Channel.setDirectTarget, (event, candidate: unknown) => handlers.setDirectTarget(event, candidate));
  ipcMain.handle(Channel.directForward, (event) => handlers.forwardDirect(event));
  ipcMain.handle(Channel.cancelDirectForward, (event, candidate: unknown) =>
    handlers.cancelDirectForward(event, candidate),
  );
}
