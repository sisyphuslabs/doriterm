import { Button, Dialog, SettingRow } from "@doriface/ui";
import { Laptop, Monitor, Server } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { hostFailure } from "../connection/host-failure.ts";
import { useConnection, useConnectionSettings, type ConnectionState } from "../connection/store.ts";
import { desktopDevices, type DesktopDevicesAnswer } from "../desktop/device-bridge.ts";
import type { DesktopPairedDevice } from "../desktop/pair-bridge.ts";
import { hostRouteOf } from "./host-route.ts";
import { PairDeviceOffer } from "./pair-device-offer.tsx";
import { deviceSummary, pairedDevicesView, type PairedDevicesView } from "./paired-devices.ts";
import { sessionPathLabel } from "./session-path.ts";
import { linkFacts } from "./round-trip.ts";
import { useHostRoundTrip } from "./use-host-round-trip.ts";
import { desktopBridge } from "../desktop/bridge.ts";
import { useBrowserMembership } from "../mesh/membership-state.ts";
import { MembershipDeviceSection } from "./membership-device.tsx";

function describe(state: ConnectionState): ReactNode {
  switch (state.phase) {
    case "open":
      // A session being carried on is not connected: say why the host is not back, once a dial has said (#496).
      if (state.resuming === true)
        return state.resumeFailure === undefined ? "Reconnecting" : hostFailure(state.resumeFailure);
      return "Connected";
    case "connecting":
      return "Connecting";
    case "failed":
      return (
        <>
          {hostFailure(state.error)}
          {/* The transport's own words (a close code) only behind a disclosure, for a report (#477). */}
          <details className="mt-1 text-xs">
            <summary className="cursor-pointer">Details</summary>
            <span className="[overflow-wrap:anywhere]">{state.error.message}</span>
          </details>
        </>
      );
    case "host-failed":
      return state.failure.message;
    case "unconfigured":
      return "Not paired yet";
  }
}

function label(icon: ReactNode, text: string, prefix = "") {
  return (
    <span className="flex items-start gap-2 [&_svg:not([data-slot=spinner])]:size-4 [&_svg]:text-muted-foreground">
      {/* One line tall, so the icon centres on the text's first line however many lines the text takes. */}
      <span className="flex h-[1lh] shrink-0 items-center">{icon}</span>
      <span className="min-w-0">
        {prefix}
        {text}
      </span>
    </span>
  );
}

/** What the paired-devices row says above the list: why it is empty, or what revoking does. */
function devicesDescription(view: PairedDevicesView): string {
  switch (view.kind) {
    case "unsupported":
      return "";
    case "asking":
      return "Asking this computer's host…";
    case "failed":
      return view.reason;
    case "empty":
      return "No phone or browser is paired with this computer.";
    case "listed":
      return "These devices reach this computer's terminals. Revoking one closes its session at once.";
  }
}

/**
 * This device, the host it is set up for, — on this computer's own host — the offer that pairs a new device to it and
 * the devices already paired. The list and the revoke come from the shell, which asks the running host over its
 * token-guarded loopback, so a member revokes a lost phone from the computer it was paired to, with no terminal.
 */
function PairedDevicesSection() {
  const state = useConnection();
  const settings = useConnectionSettings();
  const route = hostRouteOf(settings);
  const roundTrip = useHostRoundTrip(state.phase === "open" ? state.connection : null);
  const devices = useMemo(() => desktopDevices(), []);
  const [paired, setPaired] = useState<DesktopDevicesAnswer | null>(null);
  const [revoking, setRevoking] = useState<DesktopPairedDevice | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const view = pairedDevicesView(paired, devices !== null);
  // The host names itself as it answers; that name is kept beside the paired host, so the row still names it once the
  // link drops or the page is loaded again while it is down (#496). The id is only left when no name was ever learned.
  const name = state.phase === "open" ? state.connection.hello.core.name : settings.hostName;
  const host = name !== "" ? name : settings.mode === "relay" ? settings.hostId || "No host" : settings.loopbackUrl;
  useEffect(() => {
    if (devices === null) return;
    let cancelled = false;
    devices.list().then(
      (answer) => !cancelled && setPaired(answer),
      (error: unknown) =>
        !cancelled &&
        setPaired({ state: "unavailable", reason: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [devices]);

  const revoke = async (device: DesktopPairedDevice): Promise<void> => {
    setRevoking(null);
    if (devices === null) return;
    try {
      const answer = await devices.revoke(device.id);
      if (answer.state === "unavailable") return setNote(answer.reason);
      setPaired({ state: "listed", devices: answer.devices });
      setNote(
        answer.state === "revoked"
          ? `${answer.device.name} can no longer reach this computer.`
          : "That device was already gone.",
      );
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <>
      <SettingRow
        title={label(<Monitor aria-hidden />, desktopBridge() === null ? "This browser" : host)}
        description={desktopBridge() === null ? "Not in a mesh" : "This device"}
        control={null}
      />
      <SettingRow
        title={label(<Server aria-hidden />, host, desktopBridge() === null ? "Connected through " : "")}
        description={
          <>
            {describe(state)}
            {state.phase === "open" ? (
              <span className="block text-muted-foreground">
                {sessionPathLabel(state.path, state.directReason)}
                {linkFacts(state.connectMs, roundTrip).map((fact) =>
                  fact.kind === "connect" ? ` · connected in ${fact.ms} ms` : ` · ${fact.ms} ms round trip`,
                )}
              </span>
            ) : route.label === undefined ? null : (
              <span className="block text-muted-foreground">{route.label}</span>
            )}
          </>
        }
        control={null}
      />
      {desktopBridge() === null ? <Button render={<a href="/join" />}>Join a mesh</Button> : null}
      <PairDeviceOffer />
      {view.kind === "unsupported" ? null : (
        <>
          <SettingRow
            title={label(<Laptop aria-hidden />, "Other devices")}
            description={devicesDescription(view)}
            control={null}
          />
          {view.kind === "listed"
            ? view.devices.map((device) => (
                <SettingRow
                  key={device.id}
                  title={device.name}
                  description={deviceSummary(device)}
                  control={
                    <Button size="sm" onClick={() => setRevoking(device)}>
                      Revoke
                    </Button>
                  }
                />
              ))
            : null}
          {note === null ? null : (
            <p role="status" className="text-prose text-muted-foreground">
              {note}
            </p>
          )}
        </>
      )}
      <Dialog
        open={revoking !== null}
        alert
        title={`Revoke ${revoking?.name ?? "this device"}?`}
        description="It loses access to this computer at once and has to be paired again with a new code."
        className="w-[min(28rem,calc(100%-2rem))]"
        onOpenChange={(next) => {
          if (!next) setRevoking(null);
        }}
        actions={
          <>
            <Button variant="ghost" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (revoking !== null) void revoke(revoking);
              }}
            >
              Revoke
            </Button>
          </>
        }
      />
    </>
  );
}

export function DevicesSection() {
  const mesh = useBrowserMembership();
  return mesh.phase !== "empty" && desktopBridge() === null ? <MembershipDeviceSection /> : <PairedDevicesSection />;
}
