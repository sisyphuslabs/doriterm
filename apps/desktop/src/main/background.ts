import type { DesktopPlatform } from "../shared/bridge.ts";
import { readSaved, writeSaved, type Log } from "./window-state.ts";

/**
 * What closing the last window does: quit the app (and its host with it), keep it running in the Dock, or keep it
 * running out of sight with no Dock icon and no menu bar (#1500).
 */
export type LastWindowClosed = "quit" | "stay" | "hide";

/**
 * Keep running in the background (#1500). Off, closing the last window does what it always has: a Mac keeps the app in
 * the Dock, Windows and Linux quit it. On, the app and its host keep serving the phone and the relay: a Mac also drops
 * its Dock icon and menu bar, and Windows and Linux keep it running with no window, so nothing is left in the taskbar.
 * Opening the app again brings the window back either way.
 */
export function lastWindowClosed(platform: DesktopPlatform, runInBackground: boolean): LastWindowClosed {
  if (!runInBackground) return platform === "darwin" ? "stay" : "quit";
  return platform === "darwin" ? "hide" : "stay";
}

/** Whether Keep running in the background is on, as saved in `file`; off when nothing was saved or it is unreadable. */
export function savedRunInBackground(file: string, log?: Log): boolean {
  const saved = readSaved(file, log);
  return typeof saved === "object" && saved !== null && Reflect.get(saved, "enabled") === true;
}

export function saveRunInBackground(file: string, enabled: boolean, log?: Log): void {
  writeSaved(file, { enabled }, log);
}
