import { meshStatus } from "@doriface/host";
import { meshFixture } from "@doriface/host/testing";
import type { MachineView, MeshStatus } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { disagreement, meshGroups } from "./groups.ts";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const fixture = meshFixture(NOW);
const status = meshStatus(fixture.sources, NOW);

const machine = (name: string, state: string): MachineView => ({
  name,
  state,
  host: name,
  id: `${name}-id`,
  target: "doriface-host connect --mesh x",
  version: "0.1.17",
  via: true,
});

const names = (entries: readonly { readonly name: string }[]) => entries.map((entry) => entry.name);

describe("meshGroups", () => {
  test("joins first, then the fail-closed removal, members by line, and revoked keys", () => {
    const groups = meshGroups(status);
    expect(names(groups.pending)).toEqual(["ci-runner"]);
    expect(groups.removed.map((removal) => [names(removal.members), removal.revokedKey.name])).toEqual([
      [["spare"], "kiosk"],
    ]);
    expect(names(groups.online)).toEqual(["studio", "build-box"]);
    expect(names(groups.offline)).toEqual(["laptop", "tablet"]);
  });

  test("a member a fail-closed conflict removed shows under the removal, not again as revoked", () => {
    expect(names(meshGroups(status).revoked)).toEqual(["kiosk"]);
  });

  test("an over-cap member is offline even with its line up", () => {
    const overCap: MeshStatus = {
      ...status,
      members: status.members.map((member) => (member.name === "build-box" ? { ...member, overCap: true } : member)),
    };
    expect(names(meshGroups(overCap).offline)).toContain("build-box");
  });
});

describe("disagreement with machine.list", () => {
  test("none when every member the document calls connected is connected here; offline laptop may be missing", () => {
    expect(disagreement(status, [machine("build-box", "connected")], undefined)).toBeUndefined();
  });

  test.each([
    ["missing", []],
    ["unreachable here", [machine("build-box", "unreachable")]],
  ])("a member the document calls connected but %s", (_, machines) => {
    expect(disagreement(status, machines, undefined)).toEqual({ otherHost: false, names: ["build-box"] });
  });

  test("a revoked member still connected here", () => {
    const machines = [machine("build-box", "connected"), machine("kiosk", "connected")];
    expect(disagreement(status, machines, undefined)).toEqual({ otherHost: false, names: ["kiosk"] });
  });

  test("a document written for another host than the one this client paired with", () => {
    const machines = [machine("build-box", "connected")];
    expect(disagreement(status, machines, "x".repeat(26))).toEqual({ otherHost: true, names: [] });
    expect(disagreement(status, machines, fixture.ids.studio.hostId)).toBeUndefined();
  });
});
