import { base64urlDecode, fingerprintOf, hostIdOf } from "@doriface/crypto";
import {
  MESH_STATUS_VERSION,
  type MeshMemberStatus,
  type MeshNotice,
  type MeshRemovedStatus,
  type MeshRevokedStatus,
  type MeshStatus,
  type MeshStuckReason,
} from "@doriface/protocol";
import type { MeshSources } from "./status-sources.ts";

/** How long a new-member notice shows, and how long a member may be unreachable before status offers a revoke. */
export const NOTICE_MS = 7 * 24 * 60 * 60 * 1000;
export const UNREACHABLE_REVOKE_MS = 7 * 24 * 60 * 60 * 1000;
/** The mesh log cap (design section 3.3). */
export const MAX_MESH_RECORDS = 4096;

export const hostIdOfKey = (signPub: string): string => hostIdOf(base64urlDecode(signPub));
export const fingerprintOfKey = (noisePub: string): string => fingerprintOf(base64urlDecode(noisePub));
const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

interface Names {
  readonly hostId: (key: string) => string;
  readonly name: (key: string) => string;
}

function namesOf(sources: MeshSources): Names {
  const name = (key: string): string =>
    sources.view.name.get(key) ?? sources.view.revocations.get(key)?.name ?? hostIdOfKey(key);
  return { hostId: hostIdOfKey, name };
}

function member(sources: MeshSources, names: Names, key: string, now: Date): MeshMemberStatus {
  const { view, local } = sources;
  const hostId = names.hostId(key);
  const name = names.name(key);
  const self = key === local.self;
  const peer = self ? undefined : sources.peers.get(key);
  const since = peer?.unreachableSince ?? null;
  const stale = since !== null && now.getTime() - since.getTime() > UNREACHABLE_REVOKE_MS;
  const admitter = view.admitter.get(key);
  const witness = self ? { pool: [], ask: null } : sources.witnessPool(key);
  const noise = view.noise.get(key);
  return {
    hostId,
    name,
    localName: local.localNames.get(hostId) ?? name,
    fingerprint: noise === undefined ? "" : fingerprintOfKey(noise),
    admittedBy: admitter === undefined ? null : names.hostId(admitter),
    overCap: view.overCap.includes(key),
    line: self ? "self" : (sources.lines.get(key)?.state ?? "absent"),
    presence: peer?.presence ?? false,
    lastSync: iso(peer?.lastSync ?? null),
    owed: peer?.owed ?? 0,
    gate:
      peer?.gate === undefined || peer.gate === null
        ? null
        : { kind: "offline", refusals: peer.gate.refusals, nextProbeAt: peer.gate.nextProbeAt.toISOString() },
    witnessPool: witness.pool.map(names.hostId),
    witnessAsk: witness.ask === null ? null : names.hostId(witness.ask),
    unreachableSince: iso(since),
    revokeSuggested: stale,
  };
}

function revokedOf(sources: MeshSources, names: Names): MeshRevokedStatus[] {
  return sources.view.revoked.flatMap((key) => {
    const fact = sources.view.revocations.get(key);
    if (fact === undefined) return [];
    return [
      {
        hostId: names.hostId(key),
        name: fact.name,
        fingerprint: fingerprintOfKey(fact.noisePub),
        revokedBy: fact.by.map(names.hostId),
        reason: fact.reason,
        at: fact.at,
      },
    ];
  });
}

function removedOf(sources: MeshSources, names: Names): MeshRemovedStatus[] {
  const entry = (key: string) => ({ hostId: names.hostId(key), name: names.name(key) });
  return sources.view.failClosed.map((fact) => ({
    members: fact.removed.map(entry),
    revokedKey: entry(fact.revokedKey),
  }));
}

function noticesOf(sources: MeshSources, names: Names, now: Date): MeshNotice[] {
  return sources.view.members.flatMap((key) => {
    const seen = sources.local.noticed.get(key);
    const admitter = sources.view.admitter.get(key);
    const noise = sources.view.noise.get(key);
    if (key === sources.local.self || seen === undefined || admitter === undefined || noise === undefined) return [];
    const until = seen.getTime() + NOTICE_MS;
    if (now.getTime() >= until) return [];
    return [
      {
        hostId: names.hostId(key),
        name: names.name(key),
        admittedBy: names.hostId(admitter),
        fingerprint: fingerprintOfKey(noise),
        seenAt: seen.toISOString(),
        until: new Date(until).toISOString(),
      },
    ];
  });
}

function stuckOf(sources: MeshSources, names: Names, now: Date): MeshStuckReason[] {
  const { local, view } = sources;
  const reasons: MeshStuckReason[] = [];
  if (local.possiblyRevoked) reasons.push({ kind: "possibly_revoked" });
  if (local.readOnlyUntil !== null && local.readOnlyUntil.getTime() > now.getTime()) {
    const revocation = view.revocations.get(local.self);
    reasons.push({
      kind: "read_only",
      until: local.readOnlyUntil.toISOString(),
      by: (revocation?.by ?? []).map(names.hostId),
      at: revocation?.at ?? null,
    });
  }
  if (view.failClosed.some((fact) => fact.removed.includes(local.self))) reasons.push({ kind: "removed_undecidable" });
  if (local.records >= MAX_MESH_RECORDS) reasons.push({ kind: "log_full", records: local.records });
  if (local.counter.file < local.counter.mesh) {
    reasons.push({ kind: "counter_behind", file: local.counter.file, mesh: local.counter.mesh });
  }
  for (const key of [...view.members, ...view.overCap]) {
    const stuck = sources.lines.get(key)?.stuck;
    if (stuck !== undefined && stuck !== null) reasons.push({ ...stuck, member: names.hostId(key) });
  }
  return reasons;
}

/** The status of the mesh on this host (design section 8.6): what `mesh status --json` prints and the document holds. */
export function meshStatus(sources: MeshSources, now: Date): MeshStatus {
  const names = namesOf(sources);
  const stuck = stuckOf(sources, names, now);
  const { budget, local, view } = sources;
  return {
    v: MESH_STATUS_VERSION,
    meshId: local.meshId,
    self: names.hostId(local.self),
    generation: local.generation,
    sync: stuck.length === 0 ? "ok" : "stuck",
    stuck,
    members: [...view.members, ...view.overCap].map((key) => member(sources, names, key, now)),
    revoked: revokedOf(sources, names),
    removed: removedOf(sources, names),
    notices: noticesOf(sources, names, now),
    pending: sources.pending.map((join) => ({
      nonce: join.nonce,
      name: join.name,
      hostId: join.hostId,
      fingerprint: fingerprintOfKey(join.noisePub),
      expiresAt: join.expiresAt.toISOString(),
    })),
    budget: {
      waiting: budget.waiting,
      halvedUntil:
        budget.halvedUntil !== null && budget.halvedUntil.getTime() > now.getTime()
          ? budget.halvedUntil.toISOString()
          : null,
    },
  };
}
