import { describe, expect, test } from "bun:test";
import type { MeshStatus } from "./mesh-status.ts";
import { parseMeshStatus } from "./mesh-status-parse.ts";

const member = {
  hostId: "h".repeat(26),
  name: "build-box",
  localName: "build-box",
  fingerprint: "3FA9 4C0E 7B21 D855 9E10 0A2B 44C1 9F3E 5D6A 7788",
  admittedBy: null,
  overCap: false,
  line: "connected",
  presence: true,
  lastSync: "2026-11-03T11:58:00.000Z",
  owed: 0,
  gate: { kind: "offline", refusals: 2, nextProbeS: 60 },
  witness: { pool: ["a".repeat(26)], ask: null },
  unreachableSince: null,
  revokeCommand: null,
} as const;

const status: MeshStatus = {
  v: 1,
  meshId: "q7m2k4xw9d3b5n8r6t1v0c2z4a",
  self: "s".repeat(26),
  generation: 41,
  sync: "stuck",
  stuck: [
    { kind: "name_taken", member: member.hostId, name: "build-box" },
    { kind: "counter_behind", file: 5, mesh: 9 },
  ],
  members: [member],
  revoked: [{ hostId: "k".repeat(26), name: "kiosk", fingerprint: "", revokedBy: [], reason: "compromised", at: null }],
  removed: [
    { members: [{ hostId: "p".repeat(26), name: "spare" }], revokedKey: { hostId: "k".repeat(26), name: "kiosk" } },
  ],
  notices: [],
  pending: [
    { nonce: "n", name: "ci-runner", hostId: "c".repeat(26), fingerprint: "", expiresAt: "2026-11-03T12:08:00Z" },
  ],
  budget: { waiting: 1, halvedUntil: null },
};

const without = (key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(status).filter(([name]) => name !== key));

describe("parseMeshStatus", () => {
  test("reads back a status that went through JSON", () => {
    expect(parseMeshStatus(JSON.parse(JSON.stringify(status)))).toEqual(status);
  });

  test("ignores members a newer writer added", () => {
    const newer = { ...status, later: true };
    expect(parseMeshStatus(newer)).toEqual(newer);
  });

  test.each(Object.keys(status))("refuses a document without %s", (key) => {
    expect(parseMeshStatus(without(key))).toBeUndefined();
  });

  test.each([
    ["another version", { ...status, v: 2 }],
    ["an unknown line state", { ...status, members: [{ ...member, line: "online" }] }],
    ["a negative count", { ...status, members: [{ ...member, owed: -1 }] }],
    ["an unknown STUCK reason", { ...status, stuck: [{ kind: "melted" }] }],
    ["a member STUCK reason without its member", { ...status, stuck: [{ kind: "line_idle" }] }],
    ["an unknown revoke reason", { ...status, revoked: [{ ...status.revoked[0], reason: "bored" }] }],
    ["not an object", ["doriface-mesh"]],
  ])("refuses %s", (_, value) => {
    expect(parseMeshStatus(value)).toBeUndefined();
  });
});
