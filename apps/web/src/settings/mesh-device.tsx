import { Button, SettingRow } from "@doriface/ui";
import { Monitor, Server } from "lucide-react";
import type { MemberEntry } from "../connection/mesh-connections.ts";
import { formatAge } from "../workspace/model.ts";

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
      // A session being carried on over a new socket is not online yet: the row says what the status bar says (#2421).
      return entry.state.resuming === true ? "Reconnecting" : "Online";
    case "connecting":
      return "Connecting";
    case "failed":
      return entry.state.settling === true ? "Settling" : "Offline";
    case "host-failed":
    case "unconfigured":
      return "Offline";
  }
}

/** Every machine has one row; the local marker is supplied only by the shell's own-computer identity. */
export function MeshMachineList({
  entries,
  ownComputer,
  retry,
  openMember,
}: {
  readonly entries: readonly MemberEntry[];
  readonly ownComputer: string | undefined;
  readonly retry: (hostId: string) => void;
  readonly openMember?: (hostId: string) => void;
}) {
  return (
    <ul aria-label="Machines" className="flex flex-col divide-y divide-border">
      {sortedMachines(entries).map((entry) => (
        <li key={entry.target.hostId}>
          <SettingRow
            inline
            className="border-b-0"
            title={
              <span className="flex items-center gap-2 [&_svg:not([data-slot=spinner])]:size-4 [&_svg]:shrink-0">
                {ownComputer === entry.target.hostId ? <Monitor aria-hidden /> : <Server aria-hidden />}
                <span className="min-w-0 [overflow-wrap:anywhere]">{entry.target.hostName || entry.target.hostId}</span>
              </span>
            }
            description={
              <>
                {ownComputer === entry.target.hostId ? <span className="block">This machine</span> : null}
                <span>{`${stateOf(entry)} · Relay`}</span>
                {entry.state.phase !== "open" && entry.lastSeen !== undefined ? (
                  <span className="block">{`Last seen ${formatAge(entry.lastSeen, Date.now())} ago`}</span>
                ) : null}
                {entry.state.phase === "host-failed" ? (
                  <span className="block">{entry.state.failure.message}</span>
                ) : null}
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
      ))}
    </ul>
  );
}
