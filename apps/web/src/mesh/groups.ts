import type { MachineView, MeshMemberStatus, MeshPendingJoin, MeshRemovedStatus, MeshStatus } from "@doriface/protocol";
import { HOST_ID_PATTERN } from "@doriface/relay-client";

/** What a pending join's row offers: the two answers, nothing (expired), or the answer this device gave. */
export type PendingAnswer = "open" | "expired" | "approve" | "deny";

/**
 * A join dies with its offer (design 4.3), and the document can outlive the host that wrote it, so an expired offer
 * takes no answer and never reads as admitted, even if this device approved it before it expired.
 */
export function pendingAnswer(
  join: MeshPendingJoin,
  now: number,
  answered: "approve" | "deny" | undefined,
): PendingAnswer {
  if (now >= Date.parse(join.expiresAt)) return "expired";
  return answered ?? "open";
}

export interface MeshGroups {
  /** Joins whose offer is still open: only these wait for the owner. */
  readonly pending: readonly MeshPendingJoin[];
  /** Joins whose offer ended; they need nothing and come last. */
  readonly expired: readonly MeshPendingJoin[];
  readonly removed: readonly MeshRemovedStatus[];
  readonly online: readonly MeshMemberStatus[];
  readonly offline: readonly MeshMemberStatus[];
  /**
   * Revoked keys are counted, never listed: a removed machine is gone for the person, on every device at once. The
   * signed revoke stays, and `doriface-host mesh status --json` still lists every one.
   */
  readonly revokedCount: number;
}

export const isOnline = (member: MeshMemberStatus): boolean =>
  !member.overCap && (member.line === "self" || member.line === "connected");

/**
 * What approving this join grants, said on the row itself.
 *
 * A client is owner-equivalent: the gateway forwards its plaintext to hc with no method policy, so approving it is
 * approving control of every machine it can reach, and the row has to say that rather than call it a device (design of
 * #942, section 4). A machine joining is the ordinary case and gets no line of its own.
 */
export function approvalConsequence(kind: "machine" | "client", name: string): string | undefined {
  return kind === "client" ? `Approving gives ${name} control of every machine in this mesh.` : undefined;
}

/**
 * The panel's groups, most urgent first: joins waiting for this device, members an undecidable revoke removed, then
 * the members by whether their line is up, then how many keys were revoked. A member a fail-closed conflict removed
 * is also revoked in the view; it shows once, under the removal that explains it, and is not counted again.
 */
export function meshGroups(status: MeshStatus, now: number): MeshGroups {
  const removed = new Set(status.removed.flatMap((group) => group.members.map((entry) => entry.hostId)));
  const open = (join: MeshPendingJoin): boolean => pendingAnswer(join, now, undefined) !== "expired";
  return {
    pending: status.pending.filter(open),
    expired: status.pending.filter((join) => !open(join)),
    removed: status.removed,
    online: status.members.filter(isOnline),
    offline: status.members.filter((member) => !isOnline(member)),
    revokedCount: status.revoked.filter((entry) => !removed.has(entry.hostId)).length,
  };
}

export interface Disagreement {
  /** The document names another host than the one this client paired with. */
  readonly otherHost: boolean;
  /** Machines whose line the document and machine.list tell differently. */
  readonly names: readonly string[];
}

/** The pinned via form of a mesh line (design section 7.2); what it dials is its last word, a hostId. */
const MESH_LINE = / connect --mesh --state-dir '(?:[^']|'\\'')*' (\S+)$/;

/** The member a machine.list entry is the mesh line to, or undefined for any other machine. */
export function meshLineHostId(machine: MachineView): string | undefined {
  const dialed = machine.via === true ? MESH_LINE.exec(machine.target)?.[1] : undefined;
  return dialed !== undefined && HOST_ID_PATTERN.test(dialed) ? dialed : undefined;
}

/**
 * Any client can overwrite the document, so the panel checks it against what it sees itself (design section 8.6),
 * both ways. A member's machine is its mesh line (found by the hostId it dials), else the machine with its local
 * name. A member the document calls connected must be connected here and one it calls anything else must not be,
 * except a `connecting` line the document itself says just came up (no `unreachableSince`, no revoke offered): it is
 * connected here before the host republishes. A member kept `connecting` since it went unreachable still disagrees;
 * a connected mesh line must belong to a member the document lists (a forged omission otherwise); a revoked member's
 * machine must not be connected. The document must also be this host's. An offline member may be missing from
 * machine.list: herdr keeps a machine only after its first hello.
 */
export function disagreement(
  status: MeshStatus,
  machines: readonly MachineView[],
  pairedHostId: string | undefined,
): Disagreement | undefined {
  const lines = new Map<string, MachineView>();
  for (const machine of machines) {
    const hostId = meshLineHostId(machine);
    if (hostId !== undefined) lines.set(hostId, machine);
  }
  const named = new Map(machines.map((machine) => [machine.name, machine]));
  const connectedHere = (hostId: string, localName: string | null): boolean =>
    (lines.get(hostId) ?? (localName === null ? undefined : named.get(localName)))?.state === "connected";
  const listed = new Set([status.self, ...status.members.map((m) => m.hostId), ...status.revoked.map((r) => r.hostId)]);
  const names = new Set([
    ...status.members
      .filter((m) => {
        const here = connectedHere(m.hostId, m.localName);
        const justUp = m.line === "connecting" && m.unreachableSince === null && !m.revokeSuggested;
        return m.line === "connected" ? !here : here && m.line !== "self" && !justUp;
      })
      .map((m) => m.name ?? m.hostId),
    ...[...lines]
      .filter(([hostId, machine]) => machine.state === "connected" && !listed.has(hostId))
      .map(([, machine]) => machine.name),
    ...status.revoked.filter((entry) => connectedHere(entry.hostId, entry.localName)).map((entry) => entry.name),
  ]);
  const otherHost = pairedHostId !== undefined && pairedHostId !== "" && pairedHostId !== status.self;
  return names.size === 0 && !otherHost ? undefined : { otherHost, names: [...names] };
}
