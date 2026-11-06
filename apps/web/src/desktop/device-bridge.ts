import { bridgeMethod } from "./bridge.ts";
import type { DesktopPairedDevice } from "./pair-bridge.ts";

/** Every device this computer has stored; `unavailable` says why this app cannot ask its host at all. */
export type DesktopDevicesAnswer =
  | { readonly state: "listed"; readonly devices: readonly DesktopPairedDevice[] }
  | { readonly state: "unavailable"; readonly reason: string };

/** What a revoke answered: the list as it stands after, or why it did not happen. */
export type DesktopRevokeAnswer =
  | {
      readonly state: "revoked";
      readonly device: DesktopPairedDevice;
      readonly devices: readonly DesktopPairedDevice[];
    }
  | { readonly state: "not-found"; readonly devices: readonly DesktopPairedDevice[] }
  | { readonly state: "unavailable"; readonly reason: string };

export interface DesktopDevices {
  readonly list: () => Promise<DesktopDevicesAnswer>;
  readonly revoke: (id: string) => Promise<DesktopRevokeAnswer>;
}

const text = (value: unknown, key: string): string | undefined => {
  const field: unknown = typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  return typeof field === "string" ? field : undefined;
};

/** A device the shell relayed, checked here because the page reads the bridge as an untrusted boundary. */
export function relayedDevice(value: unknown): DesktopPairedDevice | undefined {
  const name = text(value, "name");
  const id = text(value, "id");
  const pairedAt = text(value, "pairedAt");
  return name === undefined || id === undefined || pairedAt === undefined ? undefined : { name, id, pairedAt };
}

export function relayedDevices(value: unknown): readonly DesktopPairedDevice[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const devices: DesktopPairedDevice[] = [];
  for (const entry of value) {
    const device = relayedDevice(entry);
    if (device === undefined) return undefined;
    devices.push(device);
  }
  return devices;
}

export function devicesAnswer(value: unknown): DesktopDevicesAnswer | undefined {
  const state = text(value, "state");
  if (state === "unavailable") {
    const reason = text(value, "reason");
    return reason === undefined ? undefined : { state, reason };
  }
  if (state !== "listed") return undefined;
  const devices = relayedDevices(typeof value === "object" && value !== null ? Reflect.get(value, "devices") : null);
  return devices === undefined ? undefined : { state, devices };
}

export function revokeAnswer(value: unknown): DesktopRevokeAnswer | undefined {
  const state = text(value, "state");
  const devices = relayedDevices(typeof value === "object" && value !== null ? Reflect.get(value, "devices") : null);
  if (state === "unavailable") {
    const reason = text(value, "reason");
    return reason === undefined ? undefined : { state, reason };
  }
  if (devices === undefined) return undefined;
  if (state === "not-found") return { state, devices };
  if (state !== "revoked") return undefined;
  const device = relayedDevice(typeof value === "object" && value !== null ? Reflect.get(value, "device") : null);
  return device === undefined ? undefined : { state, device, devices };
}

/**
 * This computer's paired devices and a revoke, from the desktop shell; null in a browser or a shell that has neither
 * call. The list is the host's, so it names the devices paired to the computer the app runs on, not this browser.
 */
export function desktopDevices(scope: object = globalThis): DesktopDevices | null {
  const list = bridgeMethod("pairedDevices", scope);
  const revoke = bridgeMethod("revokeDevice", scope);
  if (list === null || revoke === null) return null;
  return {
    list: async () => {
      const answer = devicesAnswer(await list());
      if (answer === undefined) throw new Error("the desktop app answered with no device list");
      return answer;
    },
    revoke: async (id) => {
      const answer = revokeAnswer(await revoke(id));
      if (answer === undefined) throw new Error("the desktop app answered with no revoke result");
      return answer;
    },
  };
}
