import type { MeshStatus } from "../mesh-status.ts";

export const member = {
  hostId: "h".repeat(26),
  name: "build-box",
  localName: "build-box",
  fingerprint: "3FA9 4C0E 7B21 D855 9E10 0A2B 44C1 9F3E 5D6A 7788",
  admittedBy: null,
  overCap: false,
  line: "connected",
  lineReason: null,
  helloCoreId: "core-build-box",
  replacedMachine: null,
  presence: true,
  lastSync: "2026-11-03T11:58:00.000Z",
  owed: 0,
  gate: { kind: "offline", refusals: 2, nextProbeAt: "2026-11-03T12:01:00.000Z" },
  witnessPool: ["a".repeat(26)],
  witnessAsk: "a".repeat(26),
  unreachableSince: null,
  revokeSuggested: false,
} as const;

export const self = {
  ...member,
  hostId: "s".repeat(26),
  name: "studio",
  localName: "studio",
  line: "self",
  presence: false,
  lastSync: null,
  gate: null,
  witnessPool: [],
  witnessAsk: null,
} as const;

export const status: MeshStatus = {
  v: 1,
  meshId: "q7m2k4xw2d3b5n6r6t7v3c2z4a",
  self: "s".repeat(26),
  generation: 41,
  sync: "stuck",
  stuck: [
    { kind: "name_taken", member: member.hostId, name: "build-box" },
    { kind: "invalid_name", member: member.hostId, name: "build-box", message: "bad name" },
    { kind: "copied_core", member: member.hostId },
    { kind: "line_idle", member: member.hostId },
    { kind: "possibly_revoked" },
    { kind: "read_only", until: "2026-11-10T12:00:00.000Z", by: [member.hostId], at: null },
    { kind: "removed_undecidable" },
    { kind: "log_full", records: 4096 },
    { kind: "counter_behind", file: 5, mesh: 9 },
  ],
  members: [self, member],
  revoked: [
    {
      hostId: "k".repeat(26),
      name: "kiosk",
      localName: "kiosk",
      fingerprint: member.fingerprint,
      revokedBy: ["s".repeat(26)],
      reason: "compromised",
      at: null,
    },
  ],
  removed: [
    { members: [{ hostId: "p".repeat(26), name: "spare" }], revokedKey: { hostId: "k".repeat(26), name: "kiosk" } },
  ],
  notices: [
    {
      hostId: member.hostId,
      name: "build-box",
      admittedBy: "s".repeat(26),
      fingerprint: member.fingerprint,
      seenAt: "2026-11-02T12:00:00.000Z",
      until: "2026-11-09T12:00:00.000Z",
    },
  ],
  pending: [
    {
      nonce: "n",
      name: "ci-runner",
      hostId: "c".repeat(26),
      fingerprint: member.fingerprint,
      expiresAt: "2026-11-03T12:08:00Z",
      kind: "machine",
    },
  ],
  budget: { waiting: 1, halvedUntil: "2026-11-03T12:30:00.000Z" },
};
