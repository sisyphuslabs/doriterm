import type {
  MachineView,
  MeshMemberStatus,
  MeshPendingJoin,
  MeshRemovedStatus,
  MeshRevokedStatus,
  MeshStatus,
} from "@doriface/protocol";

export interface MeshGroups {
  readonly pending: readonly MeshPendingJoin[];
  readonly removed: readonly MeshRemovedStatus[];
  readonly online: readonly MeshMemberStatus[];
  readonly offline: readonly MeshMemberStatus[];
  readonly revoked: readonly MeshRevokedStatus[];
}

export const isOnline = (member: MeshMemberStatus): boolean =>
  !member.overCap && (member.line === "self" || member.line === "connected");

/**
 * The panel's groups, most urgent first: joins waiting for this device, members an undecidable revoke removed, then
 * the members by whether their line is up, then revoked keys. A member a fail-closed conflict removed is also revoked
 * in the view; it shows once, under the removal that explains it.
 */
export function meshGroups(status: MeshStatus): MeshGroups {
  const removed = new Set(status.removed.flatMap((group) => group.members.map((entry) => entry.hostId)));
  return {
    pending: status.pending,
    removed: status.removed,
    online: status.members.filter(isOnline),
    offline: status.members.filter((member) => !isOnline(member)),
    revoked: status.revoked.filter((entry) => !removed.has(entry.hostId)),
  };
}

export interface Disagreement {
  /** The document names another host than the one this client paired with. */
  readonly otherHost: boolean;
  /** Members whose line the document and machine.list tell differently. */
  readonly names: readonly string[];
}

/**
 * Any client can overwrite the document, so the panel checks it against what it sees itself (design section 8.6):
 * a member the document calls connected must be connected in machine.list, a revoked one must not be, and the
 * document must be this host's. An offline member may be missing from machine.list: herdr keeps a machine only
 * after its first hello.
 */
export function disagreement(
  status: MeshStatus,
  machines: readonly MachineView[],
  pairedHostId: string | undefined,
): Disagreement | undefined {
  const state = new Map(machines.map((machine) => [machine.name, machine.state]));
  const names = [
    ...status.members
      .filter((m) => m.line === "connected" && state.get(m.localName) !== "connected")
      .map((m) => m.name),
    ...status.revoked.filter((entry) => state.get(entry.name) === "connected").map((entry) => entry.name),
  ];
  const otherHost = pairedHostId !== undefined && pairedHostId !== "" && pairedHostId !== status.self;
  return names.length === 0 && !otherHost ? undefined : { otherHost, names };
}
