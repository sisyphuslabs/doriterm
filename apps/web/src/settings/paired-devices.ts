import type { DesktopDevicesAnswer } from "../desktop/device-bridge.ts";
import type { DesktopPairedDevice } from "../desktop/pair-bridge.ts";

/** What Settings says about this computer's paired devices: that it cannot ask, is asking, failed, or what it has. */
export type PairedDevicesView =
  | { readonly kind: "unsupported" }
  | { readonly kind: "asking" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "empty" }
  | { readonly kind: "listed"; readonly devices: readonly DesktopPairedDevice[] };

export function pairedDevicesView(answer: DesktopDevicesAnswer | null, supported = true): PairedDevicesView {
  if (!supported) return { kind: "unsupported" };
  if (answer === null) return { kind: "asking" };
  switch (answer.state) {
    case "unavailable":
      return { kind: "failed", reason: answer.reason };
    case "listed":
      return answer.devices.length === 0 ? { kind: "empty" } : { kind: "listed", devices: answer.devices };
  }
}

/** The one-line summary a row carries: the short id a member reads on the other device, and when it paired. */
export function deviceSummary(device: DesktopPairedDevice): string {
  const at = new Date(device.pairedAt);
  const when = Number.isNaN(at.getTime()) ? "" : ` · paired ${at.toLocaleDateString()}`;
  return `${device.id}${when}`;
}
