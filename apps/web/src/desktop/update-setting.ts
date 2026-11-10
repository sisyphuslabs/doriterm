import { bridgeMethod } from "./bridge.ts";

/** The desktop app's update channel (#1969), mirrored from apps/desktop/src/shared/update.ts. */
export type UpdateChannel = "stable" | "beta";

/** What the desktop app's updater is doing, as the shell reports it. */
export type DesktopUpdateStatus =
  | { readonly state: "idle" | "checking" | "current" }
  | { readonly state: "downloading"; readonly version: string; readonly percent: number }
  | { readonly state: "ready"; readonly version: string }
  | { readonly state: "failed"; readonly reason: string; readonly message: string };

export interface UpdateSetting {
  channel(): Promise<UpdateChannel | null>;
  /** Resolves false when the shell did not keep it. */
  setChannel(channel: UpdateChannel): Promise<boolean>;
  check(): Promise<void>;
  /** The status now, then every change. */
  onStatus(listener: (status: DesktopUpdateStatus | null) => void): void;
}

const asChannel = (value: unknown): UpdateChannel | null => (value === "stable" || value === "beta" ? value : null);

function asStatus(value: unknown): DesktopUpdateStatus | null {
  if (typeof value !== "object" || value === null) return null;
  const field = (name: string): unknown => Reflect.get(value, name);
  const state = field("state");
  const version = field("version");
  const message = field("message");
  if (state === "idle" || state === "checking" || state === "current") return { state };
  if (state === "downloading" && typeof version === "string") {
    return { state, version, percent: Number(field("percent")) || 0 };
  }
  if (state === "ready" && typeof version === "string") return { state, version };
  if (state === "failed" && typeof message === "string") return { state, reason: String(field("reason")), message };
  return null;
}

/** The shell's update channel and status, or null outside the desktop app or in a build without an updater. */
export function desktopUpdateSetting(scope: object = globalThis): UpdateSetting | null {
  const channel = bridgeMethod("updateChannel", scope);
  const setChannel = bridgeMethod("setUpdateChannel", scope);
  const check = bridgeMethod("checkForUpdates", scope);
  const onStatus = bridgeMethod("onUpdateStatus", scope);
  if (channel === null || setChannel === null || check === null || onStatus === null) return null;
  return {
    channel: async () => asChannel(await channel()),
    setChannel: async (next) => (await setChannel(next)) === true,
    check: async () => void (await check()),
    onStatus: (listener) => void onStatus((status: unknown) => listener(asStatus(status))),
  };
}
