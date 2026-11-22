import { meshStatus } from "@doriface/host";
import { meshFixture } from "@doriface/host/testing";
import type { MachineView, MeshMemberStatus, MeshStatus } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import { approvalConsequence, disagreement, meshGroups, pendingAnswer } from "./groups.ts";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const fixture = meshFixture(NOW);
const status = meshStatus(fixture.sources, NOW);

/** A machine as machine.list shows it: a mesh line (the pinned via form, section 7.2) when a hostId is given. */
const machine = (name: string, state: string, hostId?: string): MachineView => ({
  name,
  state,
  host: name,
  id: `${name}-id`,
  target:
    hostId === undefined
      ? "ssh build@10.0.0.2"
      : `'/opt/doriface/bin/doriface-host' connect --mesh --state-dir '/var/lib/doriface' ${hostId}`,
  version: "0.1.17",
  via: true,
});
const { ids } = fixture;
const without = (name: string): MeshStatus => ({ ...status, members: status.members.filter((m) => m.name !== name) });

const names = (entries: readonly { readonly name: string | null }[]) => entries.map((entry) => entry.name);

/** The fixture status with tablet's entry patched. */
const stale = (patch: Partial<MeshMemberStatus>): MeshStatus => ({
  ...status,
  members: status.members.map((member) => (member.name === "tablet" ? { ...member, ...patch } : member)),
});

describe("meshGroups", () => {
  test("joins first, then the fail-closed removal, members by line, and revoked keys", () => {
    const groups = meshGroups(status, NOW.getTime());
    expect(names(groups.pending)).toEqual(["ci-runner"]);
    expect(groups.expired).toEqual([]);
    expect(groups.removed.map((removal) => [names(removal.members), removal.revokedKey.name])).toEqual([
      [["spare"], "kiosk"],
    ]);
    expect(names(groups.online)).toEqual(["studio", "build-box"]);
    expect(names(groups.offline)).toEqual(["laptop", "tablet"]);
  });

  test("revoked keys are counted, never listed as machines; one a fail-closed removal shows is not counted again", () => {
    const groups = meshGroups(status, NOW.getTime());
    expect(groups.revokedCount).toBe(1);
    expect(Object.keys(groups)).not.toContain("revoked");
  });

  test("an over-cap member is offline even with its line up", () => {
    const overCap: MeshStatus = {
      ...status,
      members: status.members.map((member) => (member.name === "build-box" ? { ...member, overCap: true } : member)),
    };
    expect(names(meshGroups(overCap, NOW.getTime()).offline)).toContain("build-box");
  });

  test("a join whose offer ended no longer waits for approval: it moves to its own group", () => {
    const ends = Date.parse(status.pending[0]?.expiresAt ?? "");
    expect([names(meshGroups(status, ends - 1).pending), names(meshGroups(status, ends - 1).expired)]).toEqual([
      ["ci-runner"],
      [],
    ]);
    expect([names(meshGroups(status, ends).pending), names(meshGroups(status, ends).expired)]).toEqual([
      [],
      ["ci-runner"],
    ]);
  });
});

describe("an over-cap member the view gives no name, key or lineage", () => {
  const nameless: MeshStatus = {
    ...status,
    members: status.members.map((member) =>
      member.name === "tablet"
        ? { ...member, overCap: true, line: "absent", name: null, localName: null, fingerprint: null, admittedBy: null }
        : member,
    ),
  };

  test("is offline, and machine.list is matched to it by its mesh line only", () => {
    expect(meshGroups(nameless, NOW.getTime()).offline.map((member) => member.hostId)).toContain(ids.tablet.hostId);
    const base = [machine("build-box", "connected")];
    expect(disagreement(nameless, [...base, machine("tablet", "connected")], undefined)).toBeUndefined();
    const line = [...base, machine("tablet", "connected", ids.tablet.hostId)];
    expect(disagreement(nameless, line, undefined)?.names).toEqual([ids.tablet.hostId]);
  });
});

describe("a pending join's answer", () => {
  const join = status.pending[0];
  if (join === undefined) throw new Error("the fixture has a pending join");
  const expires = Date.parse(join.expiresAt);

  test("is open until the offer expires, and expired from then on, so nobody can approve a join that is gone", () => {
    expect(pendingAnswer(join, expires - 1, undefined)).toBe("open");
    expect(pendingAnswer(join, expires, undefined)).toBe("expired");
    expect(pendingAnswer(join, expires + 60_000, undefined)).toBe("expired");
  });

  test("shows what this device answered while the offer is open", () => {
    expect(pendingAnswer(join, expires - 1, "approve")).toBe("approve");
    expect(pendingAnswer(join, expires - 1, "deny")).toBe("deny");
  });

  test("an approval of an offer that has since expired does not read as admitted", () => {
    expect(pendingAnswer(join, expires, "approve")).toBe("expired");
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

  test("a mesh line connected here for a member the document leaves out (a forged omission)", () => {
    const machines = [machine("build-box", "connected", ids["build-box"].hostId)];
    expect(disagreement(without("build-box"), machines, undefined)).toEqual({ otherHost: false, names: ["build-box"] });
  });

  test("a member the document calls offline whose mesh line is connected here", () => {
    const machines = [machine("build-box", "connected"), machine("laptop", "connected", ids.laptop.hostId)];
    expect(disagreement(status, machines, undefined)).toEqual({ otherHost: false, names: ["laptop"] });
  });

  test("a line that just came up, connecting in the document and connected here, is no disagreement yet", () => {
    const machines = [machine("build-box", "connected"), machine("tablet", "connected", ids.tablet.hostId)];
    expect(disagreement(status, machines, undefined)).toBeUndefined();
  });

  test("a member the document has kept connecting since it went unreachable, connected here, disagrees", () => {
    const since = new Date(NOW.getTime() - 9 * 24 * 60 * 60 * 1000).toISOString();
    const machines = [machine("build-box", "connected"), machine("tablet", "connected", ids.tablet.hostId)];
    expect(disagreement(stale({ unreachableSince: since }), machines, undefined)?.names).toEqual(["tablet"]);
    const forged = stale({ unreachableSince: since, revokeSuggested: true });
    expect(disagreement(forged, machines, undefined)?.names).toEqual(["tablet"]);
  });

  test("a mesh line dialing a word that is no hostId is no mesh line", () => {
    const line = machine("rogue", "connected", ids.laptop.hostId);
    const fake = { ...line, target: line.target.replace(ids.laptop.hostId, "A".repeat(26)) };
    expect(disagreement(status, [machine("build-box", "connected"), fake], undefined)).toBeUndefined();
  });

  test("a revoked member is matched by the name its machine has here, and by the hostId its mesh line dials", () => {
    const renamed: MeshStatus = {
      ...status,
      revoked: status.revoked.map((entry) => (entry.name === "kiosk" ? { ...entry, localName: "kiosk-ab12" } : entry)),
    };
    const base = [machine("build-box", "connected")];
    expect(disagreement(renamed, [...base, machine("kiosk-ab12", "connected")], undefined)?.names).toEqual(["kiosk"]);
    expect(disagreement(renamed, [...base, machine("kiosk", "connected")], undefined)).toBeUndefined();
    const byLine = [...base, machine("kiosk-other", "connected", ids.kiosk.hostId)];
    expect(disagreement(renamed, byLine, undefined)?.names).toEqual(["kiosk"]);
  });

  test("a member the document calls connected is matched to its mesh line by hostId, not by a name", () => {
    const machines = [
      machine("build-box-q3zd", "connected", ids["build-box"].hostId),
      machine("build-box", "unreachable"),
    ];
    expect(disagreement(status, machines, undefined)).toBeUndefined();
  });

  test("a document written for another host than the one this client paired with", () => {
    const machines = [machine("build-box", "connected")];
    expect(disagreement(status, machines, "x".repeat(26))).toEqual({ otherHost: true, names: [] });
    expect(disagreement(status, machines, fixture.ids.studio.hostId)).toBeUndefined();
  });
});

describe("what approving a join grants", () => {
  test("a client's row says it gets control of every machine, in the row's own words", () => {
    expect(approvalConsequence("client", "phone")).toBe("Approving gives phone control of every machine in this mesh.");
  });

  test("a machine's row adds nothing, because joining the mesh is the ordinary case", () => {
    expect(approvalConsequence("machine", "studio")).toBeUndefined();
  });
});
