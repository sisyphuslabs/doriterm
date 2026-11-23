import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { isSameOrigin } from "../config/origin.ts";
import { coreUpdateChannels, type CoreUpdateOffer } from "../shared/core-update.ts";
import { CoreUpdater } from "./core-updater.ts";
import type { HostContext } from "./host-command.ts";
import { registerUpdateIpc } from "./ipc-update.ts";
import type { UpdateWatch } from "./updater.ts";
import { writeSaved } from "./window-state.ts";

function confirm(window: BrowserWindow, offer: CoreUpdateOffer): Promise<boolean> {
  return dialog
    .showMessageBox(window, {
      type: "warning",
      title: "Update local herdr-core?",
      message: `Update herdr-core from ${offer.current} to ${offer.version}?`,
      detail: "Terminals keep running during the core restart. Their connections briefly drop and then reconnect.",
      buttons: ["Cancel", "Update and restart core"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    .then(({ response }) => response === 1);
}

export function registerDesktopUpdates(
  origin: string,
  updates: UpdateWatch | undefined,
  channelFile: string,
  context: HostContext,
  hc: () => string | undefined,
): void {
  registerUpdateIpc({
    origin,
    status: () => updates?.status ?? null,
    channel: () => updates?.channel ?? null,
    setChannel: (channel) => {
      if (updates === undefined) return false;
      writeSaved(channelFile, { channel });
      updates.setChannel(channel);
      return true;
    },
    check: () => updates?.check(),
  });

  const core = new CoreUpdater(context, hc);
  const windowOf = (event: IpcMainInvokeEvent): BrowserWindow => {
    const frame = event.senderFrame;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null || frame === null || frame !== event.sender.mainFrame || !isSameOrigin(frame.url, origin)) {
      throw new Error("Refused a core update request outside the app window.");
    }
    return window;
  };
  ipcMain.handle(coreUpdateChannels.check, (event) => {
    windowOf(event);
    return core.check();
  });
  ipcMain.handle(coreUpdateChannels.apply, (event) => {
    const window = windowOf(event);
    return core.apply((offer) => confirm(window, offer));
  });
}
