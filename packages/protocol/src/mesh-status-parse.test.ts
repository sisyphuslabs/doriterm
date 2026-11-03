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
  gate: { kind: "offline", refusals: 2, nextProbeAt: "2026-11-03T12:01:00.000Z" },
  witnessPool: ["a".repeat(26)],
  witnessAsk: null,
  unreachableSince: null,
  revokeSuggested: false,
} as const;

const self = {
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

const status: MeshStatus = {
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
    { kind: "read_only", until: "2026-11-10T12:00:00.000Z" },
    { kind: "removed_undecidable" },
    { kind: "log_full", records: 4096 },
    { kind: "counter_behind", file: 5, mesh: 9 },
  ],
  members: [self, member],
  revoked: [
    {
      hostId: "k".repeat(26),
      name: "kiosk",
      fingerprint: member.fingerprint,
      revokedBy: [],
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
    },
  ],
  budget: { waiting: 1, halvedUntil: null },
};

const without = (key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(status).filter(([name]) => name !== key));

type Path = readonly (string | number)[];
type Node = Record<string | number, unknown>;

/** The path of every object inside the status, so each nested key gets its own refusal row. */
function objectPaths(value: unknown, path: Path = []): Path[] {
  if (typeof value !== "object" || value === null) return [];
  const inner = Object.entries(value).flatMap(([key, item]) =>
    objectPaths(item, [...path, Array.isArray(value) ? Number(key) : key]),
  );
  return Array.isArray(value) || path.length === 0 ? inner : [path, ...inner];
}

const nodeAt = (root: unknown, path: Path): Node => path.reduce<Node>((node, key) => node[key] as Node, root as Node);

/** A copy of the status with `key` deleted from the object at `path`. */
function withoutNested(path: Path, key: string): unknown {
  const copy: unknown = structuredClone(status);
  delete nodeAt(copy, path)[key];
  return copy;
}

const nestedRows = objectPaths(status).flatMap((path) =>
  Object.keys(nodeAt(status, path)).map((key) => [`${path.join(".")}.${key}`, path, key] as const),
);

const memberAt = (index: number, patch: Record<string, unknown>): unknown => ({
  ...status,
  members: status.members.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)),
});

describe("parseMeshStatus", () => {
  test("reads back a status that went through JSON", () => {
    expect(parseMeshStatus(JSON.parse(JSON.stringify(status)))).toEqual(status);
  });

  test("drops a top-level key a newer writer added instead of passing it through", () => {
    expect(parseMeshStatus({ ...status, later: true })).toEqual(status);
  });

  test.each(objectPaths(status).map((path) => [path.join("."), path] as const))(
    "refuses an unknown key in %s",
    (_, path) => {
      const copy: unknown = structuredClone(status);
      nodeAt(copy, path)["later"] = true;
      expect(parseMeshStatus(copy)).toBeUndefined();
    },
  );

  test.each(Object.keys(status))("refuses a document without %s", (key) => {
    expect(parseMeshStatus(without(key))).toBeUndefined();
  });

  test("covers every nested object", () => {
    expect(nestedRows.length).toBeGreaterThan(60);
  });

  test.each(nestedRows)("refuses a document without %s", (_, path, key) => {
    expect(parseMeshStatus(withoutNested(path, key))).toBeUndefined();
  });

  test.each([
    ["another version", { ...status, v: 2 }],
    ["an unknown line state", { ...status, members: [{ ...member, line: "online" }] }],
    ["a negative count", { ...status, members: [{ ...member, owed: -1 }] }],
    ["an unknown STUCK reason", { ...status, stuck: [{ kind: "melted" }] }],
    ["a member STUCK reason without its member", { ...status, stuck: [{ kind: "line_idle" }] }],
    ["an unknown revoke reason", { ...status, revoked: [{ ...status.revoked[0], reason: "bored" }] }],
    ["not an object", ["doriface-mesh"]],
    ["sync ok with a STUCK reason", { ...status, sync: "ok" }],
    ["sync stuck without a reason", { ...status, stuck: [] }],
    ["self missing from the members", { ...status, members: [member] }],
    ["a member listed twice", { ...status, members: [self, member, member] }],
    ["two members on the self line", memberAt(1, { line: "self" })],
    ["self on another line", memberAt(0, { line: "connected" })],
    ["a member STUCK reason naming no member", { ...status, stuck: [{ kind: "line_idle", member: "z".repeat(26) }] }],
    ["an empty meshId", { ...status, meshId: "" }],
    ["a hostId of another shape", memberAt(1, { hostId: "H".repeat(26) })],
    ["an admitter that is no hostId", memberAt(1, { admittedBy: "" })],
    ["a lastSync that is not a time", memberAt(1, { lastSync: "yesterday" })],
    ["a name herdr refuses", memberAt(1, { name: "rm -rf ~" })],
    ["an id-shaped name", memberAt(1, { name: "t7" })],
    ["a local name herdr refuses", memberAt(1, { localName: "build box" })],
    ["a fingerprint of another shape", memberAt(1, { fingerprint: "abc" })],
    ["a command instead of a suggestion", memberAt(1, { revokeCommand: "rm -rf ~" })],
    ["a revoke suggested for a member that is not unreachable", memberAt(1, { revokeSuggested: true })],
    [
      "a revoke suggested for this host",
      memberAt(0, { revokeSuggested: true, unreachableSince: "2026-10-25T12:00:00.000Z" }),
    ],
    ["a read-only end that is not a time", { ...status, stuck: [{ kind: "read_only", until: "soon" }] }],
  ])("refuses %s", (_, value) => {
    expect(parseMeshStatus(value)).toBeUndefined();
  });
});
