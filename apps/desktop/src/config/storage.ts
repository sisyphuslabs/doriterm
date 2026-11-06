import { join } from "node:path";

/**
 * The app is Doriterm now, but its storage keeps the directory it was installed under: `userData` holds the renderer's
 * localStorage and the IndexedDB store with this device's key and the hosts it paired, so letting the directory follow
 * the new name would open every existing install with no device and no settings.
 */
export const LEGACY_STORAGE_DIR = "doriface";

/**
 * The folder to pin `userData` to, or undefined to leave it alone. A caller that named a profile with
 * `--user-data-dir` asked for that one (the desktop e2e does, per spec), so it keeps the command line's answer.
 */
export function storageDirToPin(appData: string, namedProfile: boolean): string | undefined {
  return namedProfile ? undefined : join(appData, LEGACY_STORAGE_DIR);
}
