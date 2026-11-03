import { base64urlEncode } from "@doriface/crypto";
import type { MeshStuckReason } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { meshFixture } from "../testing/mesh-fixture.ts";
import type { LocalFacts, MeshSources } from "./status-sources.ts";
import { MAX_MESH_RECORDS, meshStatus } from "./status.ts";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const fixture = meshFixture(NOW);
const { ids } = fixture;
const status = meshStatus(fixture.sources, NOW);
const withLocal = (local: Partial<LocalFacts>): MeshSources => ({
  ...fixture.sources,
  local: { ...fixture.sources.local, ...local },
});

describe("mesh status: sync and the dial budget", () => {
  test("a mesh with nothing wrong syncs ok, and the budget is whole", () => {
    expect(status.sync).toBe("ok");
    expect(status.stuck).toEqual([]);
    expect(status.budget).toEqual({ waiting: 0, halvedUntil: null });
  });

  const later = new Date(NOW.getTime() + 60_000);
  const revokedSelf: MeshSources = {
    ...withLocal({ readOnlyUntil: later }),
    view: {
      ...fixture.sources.view,
      revocations: new Map([
        ...fixture.sources.view.revocations,
        [
          fixture.keys.studio,
          {
            name: "studio",
            noisePub: base64urlEncode(ids.studio.noise.publicKey),
            by: [fixture.keys["build-box"]],
            reason: "revoke",
            at: "2026-11-03T11:00:00.000Z",
          },
        ],
      ]),
    },
  };
  const removedSelf = {
    ...fixture.sources,
    view: { ...fixture.sources.view, failClosed: [{ removed: [fixture.keys.studio], revokedKey: fixture.keys.kiosk }] },
  };
  const stuckLine = {
    ...fixture.sources,
    lines: new Map([
      [
        fixture.keys.tablet,
        {
          state: "connecting" as const,
          reason: null,
          stuck: { kind: "line_idle" as const },
          helloCoreId: null,
          replaced: null,
        },
      ],
    ]),
  };
  const rows: readonly (readonly [string, MeshSources, MeshStuckReason])[] = [
    ["possibly revoked", withLocal({ possiblyRevoked: true }), { kind: "possibly_revoked" }],
    [
      "read-only",
      revokedSelf,
      { kind: "read_only", until: later.toISOString(), by: [ids["build-box"].hostId], at: "2026-11-03T11:00:00.000Z" },
    ],
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
