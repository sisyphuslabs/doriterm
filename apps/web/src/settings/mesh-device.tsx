import { base64urlDecode } from "@doriface/crypto";
import { Button, SettingRow } from "@doriface/ui";
import { Monitor, Server } from "lucide-react";
import type { MemberEntry } from "../connection/mesh-connections.ts";
import { fingerprintOf } from "../pair/fragment.ts";
import { formatAge } from "../workspace/model.ts";
import { memberRouteOf, PATH_WORD } from "./member-route.ts";
import { linkFacts } from "./round-trip.ts";
import { useHostRoundTrip } from "./use-host-round-trip.ts";

/** The addresses a row needs to name its route: the relay and loopback are shared, the direct origin is the member's. */
export interface RouteAddresses {
  readonly relayUrl: string;
  readonly loopbackUrl: string;
}

export function MeshDevice({
  name,
  mesh,
  fingerprint,
  installed,
  online,
  onLeave,
}: {
  readonly name: string;
  readonly mesh: string;
  readonly fingerprint: string;
  readonly installed: boolean;
  readonly online: number;
  readonly onLeave: () => void;
}) {
  return (
    <SettingRow
      title={name}
      description={
        <>
          <span className="block">{installed ? "Home-screen app" : "Browser"}</span>
          <span className="block">{`Member of ${mesh} · ${online} machines online`}</span>
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer">Details</summary>
            <span className="font-mono [overflow-wrap:anywhere]">{fingerprint}</span>
          </details>
        </>
      }
      control={<Button onClick={onLeave}>Leave this mesh</Button>}
    />
  );
}

/** The ordering used by both the machine list and the default invitation machine. */
export function sortedMachines(entries: readonly MemberEntry[]): readonly MemberEntry[] {
  return entries.toSorted(
    (a, b) =>
      Number(b.state.phase === "open") - Number(a.state.phase === "open") ||
      a.target.hostName.localeCompare(b.target.hostName) ||
      a.target.hostId.localeCompare(b.target.hostId),
  );
}

function stateOf(entry: MemberEntry): string {
  switch (entry.state.phase) {
    case "open":
      return "Online";
    case "connecting":
      return "Connecting";
    case "failed":
      return entry.state.settling === true ? "Settling" : "Offline";
    case "host-failed":
    case "unconfigured":
      return "Offline";
  }
}

const keyFingerprint = (hostKey: string): string | undefined =>
  hostKey === "" ? undefined : fingerprintOf(base64urlDecode(hostKey));

/**
 * How this device is connected to one machine, from facts it holds or measured itself: the route and its address, the
 * encryption, how long the session took to open, a round trip timed on the live connection, and the member's public
 * identity. Nothing here is a secret: the peer id and the key fingerprint are what an invite already shows (#1550).
 */
function ConnectionDetails({ entry, addresses }: { readonly entry: MemberEntry; readonly addresses: RouteAddresses }) {
  const open = entry.state.phase === "open" ? entry.state : undefined;
  const roundTrip = useHostRoundTrip(open?.connection ?? null);
  const route = memberRouteOf(entry.state, { ...addresses, directUrl: entry.target.directUrl });
  const facts = linkFacts(open?.connectMs, roundTrip).map((fact) =>
    fact.kind === "connect" ? `Opened in ${fact.ms} ms` : `${fact.ms} ms round trip`,
  );
  const key = keyFingerprint(entry.target.hostKey);
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer">How it is connected</summary>
      <span className="block">{route?.line ?? "No session now"}</span>
      {facts.length === 0 ? null : <span className="block">{facts.join(" · ")}</span>}
      <span className="block [overflow-wrap:anywhere]">{`Peer id ${entry.target.hostId}`}</span>
      {key === undefined ? null : <span className="block font-mono [overflow-wrap:anywhere]">{`Key ${key}`}</span>}
    </details>
  );
}

/** Every machine has one row; the local marker is supplied only by the shell's own-computer identity. */
export function MeshMachineList({
  entries,
  ownComputer,
  addresses,
  retry,
  openMember,
}: {
  readonly entries: readonly MemberEntry[];
  readonly ownComputer: string | undefined;
  readonly addresses: RouteAddresses;
  readonly retry: (hostId: string) => void;
  readonly openMember?: (hostId: string) => void;
}) {
  return (
    <ul aria-label="Machines" className="flex flex-col divide-y divide-border">
      {sortedMachines(entries).map((entry) => {
        const route = memberRouteOf(entry.state, { ...addresses, directUrl: entry.target.directUrl });
        return (
          <li key={entry.target.hostId}>
            <SettingRow
              inline
              className="border-b-0"
              title={
                <span className="flex items-center gap-2 [&_svg]:size-4 [&_svg]:shrink-0">
                  {ownComputer === entry.target.hostId ? <Monitor aria-hidden /> : <Server aria-hidden />}
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    {entry.target.hostName || entry.target.hostId}
                  </span>
                </span>
              }
              description={
                <>
                  {ownComputer === entry.target.hostId ? <span className="block">This machine</span> : null}
                  <span>{route === undefined ? stateOf(entry) : `${stateOf(entry)} · ${PATH_WORD[route.path]}`}</span>
                  {entry.state.phase !== "open" && entry.lastSeen !== undefined ? (
                    <span className="block">{`Last seen ${formatAge(entry.lastSeen, Date.now())} ago`}</span>
                  ) : null}
                  {entry.state.phase === "host-failed" ? (
                    <span className="block">{entry.state.failure.message}</span>
                  ) : null}
                  <ConnectionDetails entry={entry} addresses={addresses} />
                </>
              }
              control={
                entry.state.phase === "open" && openMember !== undefined ? (
                  <Button size="sm" onClick={() => openMember(entry.target.hostId)}>
                    Open
                  </Button>
                ) : entry.state.phase === "failed" ? (
                  <Button size="sm" onClick={() => retry(entry.target.hostId)}>
                    Try now
                  </Button>
                ) : null
              }
            />
          </li>
        );
      })}
    </ul>
  );
}
