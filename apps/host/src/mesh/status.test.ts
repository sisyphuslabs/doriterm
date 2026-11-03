import { fingerprintOf } from "@doriface/crypto";
import { describe, expect, test } from "bun:test";
import { meshFixture } from "../testing/mesh-fixture.ts";
import type { LocalFacts, MeshSources } from "./status-sources.ts";
import { meshStatus, NOTICE_MS, UNREACHABLE_REVOKE_MS } from "./status.ts";

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
    const renamed = meshStatus(withLocal({ localNames: new Map([[fixture.keys.laptop, "laptop-q3zd"]]) }), NOW);
    expect(renamed.members.map((member) => [member.name, member.localName])).toEqual([
      ["studio", "studio"],
      ["build-box", "build-box"],
      ["laptop", "laptop-q3zd"],
      ["tablet", "tablet"],
    ]);
  });

  test("shows herdr's reason for a line that is down, the latest hello's core id, and a migrated machine", () => {
    expect(memberNamed("laptop")).toMatchObject({
      line: "unreachable",
      lineReason: "no route to host",
      helloCoreId: null,
    });
    expect(memberNamed("build-box")).toMatchObject({
      lineReason: null,
      helloCoreId: "core-build-box",
      replacedMachine: "build-box-old",
    });
    expect(memberNamed("tablet")).toMatchObject({ lineReason: null, replacedMachine: null });
  });

  test.each(["hc_missing", "incompatible"] as const)("a line in state %s is shown with herdr's reason", (state) => {
    const lines = new Map(fixture.sources.lines);
    lines.set(fixture.keys.tablet, { state, reason: "herdr says why", stuck: null, helloCoreId: null, replaced: null });
    expect(meshStatus({ ...fixture.sources, lines }, NOW).members.find((m) => m.name === "tablet")).toMatchObject({
      line: state,
      lineReason: "herdr says why",
    });
  });

  test("a view that revokes a key with no revoke record is a broken snapshot, not a silent omission", () => {
    expect(() => meshStatus({ ...fixture.sources, revocations: new Map() }, NOW)).toThrow("no revoke record");
  });

  test("a member without a Noise key in the view is a broken snapshot, not an empty fingerprint", () => {
    const noise = new Map(fixture.sources.view.noise);
    noise.delete(fixture.keys.tablet);
    expect(() => meshStatus({ ...fixture.sources, view: { ...fixture.sources.view, noise } }, NOW)).toThrow(
      "no Noise key",
    );
  });

  test("carries presence, last sync, owed records and the 4404 gate of each peer", () => {
    expect(memberNamed("build-box")).toMatchObject({ presence: true, lastSync: "2026-11-03T11:58:00.000Z", owed: 0 });
    expect(memberNamed("tablet")).toMatchObject({ owed: 1, gate: null });
    expect(memberNamed("laptop")?.gate).toEqual({
      kind: "offline",
      refusals: 5,
      nextProbeAt: "2026-11-03T12:04:00.000Z",
    });
  });

  test("a gated member does not change the status from one second to the next", () => {
    expect(meshStatus(fixture.sources, new Date(NOW.getTime() + 1000))).toEqual(status);
  });

  test("offers a prefilled revoke only for a member unreachable for more than 7 days", () => {
    expect(memberNamed("laptop")).toMatchObject({
      unreachableSince: "2026-10-25T12:00:00.000Z",
      revokeSuggested: true,
    });
    expect(memberNamed("build-box")?.revokeSuggested).toBe(false);
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
    expect(unreachableFor(60_000)?.revokeSuggested).toBe(false);
    expect(unreachableFor(UNREACHABLE_REVOKE_MS)?.revokeSuggested).toBe(false);
    expect(unreachableFor(UNREACHABLE_REVOKE_MS + 1)?.revokeSuggested).toBe(true);
  });

  test("computes no witness pool for this host, whose revoke it cannot write", () => {
    const asked: string[] = [];
    const sources: MeshSources = {
      ...fixture.sources,
      witnessPool: (subject) => {
        asked.push(subject);
        return fixture.sources.witnessPool(subject);
      },
    };
    expect(meshStatus(sources, NOW).members[0]).toMatchObject({ line: "self", witnessPool: [], witnessAsk: null });
    expect(asked).not.toContain(fixture.keys.studio);
    expect(asked).toHaveLength(3);
  });

  test("names the witness pool by hostId, and who to ask when it is empty here", () => {
    expect(memberNamed("laptop")).toMatchObject({ witnessPool: [], witnessAsk: ids["build-box"].hostId });
    expect(memberNamed("tablet")).toMatchObject({ witnessPool: [ids["build-box"].hostId], witnessAsk: null });
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
});
