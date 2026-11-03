import { fingerprintOf } from "@doriface/crypto";
import type { MeshStuckReason } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { meshFixture } from "../testing/mesh-fixture.ts";
import type { LocalFacts, MeshSources } from "./status-sources.ts";
import { MAX_MESH_RECORDS, meshStatus, NOTICE_MS, UNREACHABLE_REVOKE_MS } from "./status.ts";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const fixture = meshFixture(NOW);
const { ids } = fixture;
const status = meshStatus(fixture.sources, NOW);
const memberNamed = (name: string) => status.members.find((member) => member.name === name);
const withLocal = (local: Partial<LocalFacts>): MeshSources => ({
  ...fixture.sources,
  local: { ...fixture.sources.local, ...local },
});

describe("mesh status", () => {
  test("lists the members in member order with their hostIds, fingerprints, lineage and lines", () => {
    expect(status.self).toBe(ids.studio.hostId);
    expect(status.members.map((member) => [member.name, member.hostId, member.line, member.admittedBy])).toEqual([
      ["studio", ids.studio.hostId, "self", null],
      ["build-box", ids["build-box"].hostId, "connected", ids.studio.hostId],
      ["laptop", ids.laptop.hostId, "unreachable", ids.studio.hostId],
      ["tablet", ids.tablet.hostId, "connecting", ids["build-box"].hostId],
    ]);
    expect(memberNamed("tablet")?.fingerprint).toBe(fingerprintOf(ids.tablet.noise.publicKey));
  });

  test("an over-cap member is listed after the members and marked over the cap", () => {
    const { keys } = fixture;
    const view = { ...fixture.sources.view };
    const overCap = meshStatus(
      {
        ...fixture.sources,
        view: { ...view, members: view.members.filter((key) => key !== keys.laptop), overCap: [keys.laptop] },
      },
      NOW,
    );
    expect(overCap.members.map((member) => [member.name, member.overCap])).toEqual([
      ["studio", false],
      ["build-box", false],
      ["tablet", false],
      ["laptop", true],
    ]);
  });

  test("a member whose name fell back on this core shows the name it has here", () => {
    const renamed = meshStatus(withLocal({ localNames: new Map([[ids.laptop.hostId, "laptop-q3zd"]]) }), NOW);
    expect(renamed.members.map((member) => [member.name, member.localName])).toEqual([
      ["studio", "studio"],
      ["build-box", "build-box"],
      ["laptop", "laptop-q3zd"],
      ["tablet", "tablet"],
    ]);
  });

  test("carries presence, last sync, owed records and the 4404 gate of each peer", () => {
    expect(memberNamed("build-box")).toMatchObject({ presence: true, lastSync: "2026-11-03T11:58:00.000Z", owed: 0 });
    expect(memberNamed("tablet")).toMatchObject({ owed: 1, gate: null });
    expect(memberNamed("laptop")?.gate).toEqual({ kind: "offline", refusals: 5, nextProbeS: 240 });
  });

  test("offers a prefilled revoke only for a member unreachable for more than 7 days", () => {
    expect(memberNamed("laptop")).toMatchObject({
      unreachableSince: "2026-10-25T12:00:00.000Z",
      revokeCommand: "doriface-host mesh revoke laptop",
    });
    expect(memberNamed("build-box")?.revokeCommand).toBeNull();
  });

  test("the revoke offer starts only past 7 days unreachable", () => {
    const { keys } = fixture;
    const unreachableFor = (ms: number) => {
      const peers = new Map(fixture.sources.peers);
      peers.set(keys["build-box"], {
        presence: false,
        lastSync: null,
        owed: 0,
        gate: null,
        unreachableSince: new Date(NOW.getTime() - ms),
      });
      return meshStatus({ ...fixture.sources, peers }, NOW).members.find((member) => member.name === "build-box");
    };
    expect(unreachableFor(60_000)?.revokeCommand).toBeNull();
    expect(unreachableFor(UNREACHABLE_REVOKE_MS)?.revokeCommand).toBeNull();
    expect(unreachableFor(UNREACHABLE_REVOKE_MS + 1)?.revokeCommand).toBe("doriface-host mesh revoke build-box");
  });

  test("names the witness pool by hostId, and who to ask when it is empty here", () => {
    expect(memberNamed("laptop")?.witness).toEqual({ pool: [], ask: ids["build-box"].hostId });
    expect(memberNamed("tablet")?.witness).toEqual({ pool: [ids["build-box"].hostId], ask: null });
  });

  test("shows revoked members with who revoked them, and the members an undecidable revoke removed", () => {
    expect(status.revoked.map((entry) => [entry.name, entry.reason, entry.revokedBy])).toEqual([
      ["kiosk", "compromised", [ids.studio.hostId]],
      ["spare", "revoke", [ids.kiosk.hostId]],
    ]);
    expect(status.removed).toEqual([
      {
        members: [{ hostId: ids.spare.hostId, name: "spare" }],
        revokedKey: { hostId: ids.kiosk.hostId, name: "kiosk" },
      },
    ]);
  });

  test("a new-member notice lasts 7 days from when this host saw the admission", () => {
    expect(status.notices).toEqual([
      {
        hostId: ids.tablet.hostId,
        name: "tablet",
        admittedBy: ids["build-box"].hostId,
        fingerprint: fingerprintOf(ids.tablet.noise.publicKey),
        seenAt: "2026-11-02T12:00:00.000Z",
        until: "2026-11-09T12:00:00.000Z",
      },
    ]);
    const seen = Date.parse("2026-11-02T12:00:00.000Z");
    expect(meshStatus(fixture.sources, new Date(seen + NOTICE_MS - 1)).notices).toHaveLength(1);
    expect(meshStatus(fixture.sources, new Date(seen + NOTICE_MS)).notices).toEqual([]);
  });

  test("lists pending joins with the joiner's fingerprint", () => {
    expect(status.pending).toEqual([
      {
        nonce: "dGhlIGpvaW5lcidzIG5vbmNl",
        name: "ci-runner",
        hostId: ids["ci-runner"].hostId,
        fingerprint: fingerprintOf(ids["ci-runner"].noise.publicKey),
        expiresAt: "2026-11-03T12:08:00.000Z",
      },
    ]);
  });

  test("a mesh with nothing wrong syncs ok, and the budget is whole", () => {
    expect(status.sync).toBe("ok");
    expect(status.stuck).toEqual([]);
    expect(status.budget).toEqual({ waiting: 0, halvedUntil: null });
  });

  const later = new Date(NOW.getTime() + 60_000);
  const removedSelf = {
    ...fixture.sources,
    view: { ...fixture.sources.view, failClosed: [{ removed: [fixture.keys.studio], revokedKey: fixture.keys.kiosk }] },
  };
  const stuckLine = {
    ...fixture.sources,
    lines: new Map([[fixture.keys.tablet, { state: "connecting" as const, stuck: { kind: "line_idle" as const } }]]),
  };
  const rows: readonly (readonly [string, MeshSources, MeshStuckReason])[] = [
    ["possibly revoked", withLocal({ possiblyRevoked: true }), { kind: "possibly_revoked" }],
    ["read-only", withLocal({ readOnlyUntil: later }), { kind: "read_only", until: later.toISOString() }],
    ["removed by an undecidable revoke", removedSelf, { kind: "removed_undecidable" }],
    ["log full", withLocal({ records: MAX_MESH_RECORDS }), { kind: "log_full", records: MAX_MESH_RECORDS }],
    ["counter behind", withLocal({ counter: { file: 5, mesh: 9 } }), { kind: "counter_behind", file: 5, mesh: 9 }],
    ["a line that does not connect", stuckLine, { kind: "line_idle", member: ids.tablet.hostId }],
  ];
  test.each(rows)("%s makes sync STUCK with that reason", (_, sources, reason) => {
    const stuck = meshStatus(sources, NOW);
    expect(stuck.sync).toBe("stuck");
    expect(stuck.stuck).toEqual([reason]);
  });

  test.each([
    ["ends", 0],
    ["has ended", -1],
  ])("read-only is no STUCK reason once its grace period %s", (_, offset) => {
    const ended = meshStatus(withLocal({ readOnlyUntil: new Date(NOW.getTime() + offset) }), NOW);
    expect(ended.stuck).toEqual([]);
  });

  test.each([
    ["ends", 0],
    ["has ended", -1],
  ])("a halved budget is whole again once the halving %s", (_, offset) => {
    const until = new Date(NOW.getTime() + offset);
    expect(
      meshStatus({ ...fixture.sources, budget: { waiting: 0, halvedUntil: until } }, NOW).budget.halvedUntil,
    ).toBeNull();
  });

  test("a halved budget shows until when, and a waiting dial count", () => {
    const until = new Date(NOW.getTime() + 600_000);
    const halved = meshStatus({ ...fixture.sources, budget: { waiting: 3, halvedUntil: until } }, NOW);
    expect(halved.budget).toEqual({ waiting: 3, halvedUntil: until.toISOString() });
  });
});
