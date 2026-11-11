import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { viewOf } from "@doriface/mesh";
import { MeshCommands } from "./commands.ts";
import type { MemberEntry } from "./authorize-index.ts";
import { Reconciler } from "./reconciler.ts";
import { syncHooks } from "./sync-hooks.ts";
import { NOT_RUNNING } from "./live-facts.ts";
import { FakeMachines, hcError } from "./testing/fake-machines.ts";
import { hostIdFor } from "./testing/hc-mesh.ts";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import type { MeshView } from "./mesh-view.ts";
import { MeshNet } from "./testing/mesh-net.ts";
import { meshOf, peer } from "./testing/mesh-peers.ts";

/** a, b and c on one in-memory relay; `MeshCommands` on a, its pushes and confirmations through a's own gossip. */
function threeMembers(closeRevokedOnMerge = false) {
  const [a, b, c] = [peer("a"), peer("b"), peer("c")];
  const clock = new FakeClock();
  const net = new MeshNet(clock, seededRandom(78));
  const { records } = meshOf([a, b, c]);
  // As #105's HostSync does: every merge closes, at once, the sessions of keys the new view no longer holds.
  const closeOnMerge = (name: string) => (view: MeshView) => {
    const gossip = net.host(name).gossip;
    for (const key of [a, b, c].map((member) => member.signPub)) {
      if (!view.members.some((member) => member.signPub === key)) gossip.session(key)?.close(4401, "revoked");
    }
  };
  const [atA, atB, atC] = [a, b, c].map((member) =>
    net.add(member, records, closeRevokedOnMerge ? closeOnMerge(member.name) : undefined),
  );
  if (atA === undefined || atB === undefined || atC === undefined) throw new Error("no hosts");
  const sync = {
    gossip: atA.gossip,
    runtime: undefined,
    changed: () => undefined,
    stop: () => atA.gossip.stop(),
    formatReady: () => false,
    live: () => NOT_RUNNING,
  };
  const stateDir = mkdtempSync(join(tmpdir(), "dh-sync-hooks-"));
  const commands = new MeshCommands({
    store: atA.store,
    stateDir,
    identity: a.machine.identity,
    closeRevoked: () => undefined,
    hooks: syncHooks(sync, clock, () => []),
    log: () => undefined,
  });
  const cleanup = () => rmSync(stateDir, { recursive: true, force: true });
  return { a, b, c, clock, net, atB, atC, commands, cleanup };
}

/** Runs `work` while virtual time advances, until it settles; returns its value and the virtual time it took. */
async function underClock<T>(clock: FakeClock, work: Promise<T>, limitMs: number) {
  let done: { value: T } | undefined;
  void work.then((value) => {
    done = { value };
    return value;
  });
  const took = await clock.until(() => done !== undefined, limitMs);
  if (done === undefined) throw new Error("work did not settle");
  return { value: done.value, took };
}

describe("mesh revoke, rename and leave reach the other members through sync (design 5.3, 6.2, 6.5)", () => {
  test("a rename and a revoke written on a reach b's and c's stores", async () => {
    const { b, c, clock, atB, atC, commands, cleanup } = threeMembers();
    try {
      await commands.rename({ member: "b", name: "b2" });
      await clock.until(() => viewOf(atC.records()).name.get(b.signPub) === "b2", 60_000);
      await commands.revoke({ member: "c", compromised: false, yes: true });
      await clock.until(() => viewOf(atB.records()).revoked.has(c.signPub), 60_000);
    } finally {
      cleanup();
    }
  });

  test("leave reports the members that confirmed its self-revoke", async () => {
    const { b, c, clock, commands, cleanup } = threeMembers();
    try {
      const { value } = await underClock(clock, commands.leave(), 40_000);
      expect(value?.confirmed.map((member) => member.hostId).toSorted()).toEqual([b.hostId, c.hostId].toSorted());
      expect(value?.revokeCommand).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("leave is still confirmed when the members close its sessions as they merge its self-revoke (#105, L31)", async () => {
    const { b, c, clock, commands, cleanup } = threeMembers(true);
    try {
      const { value } = await underClock(clock, commands.leave(), 40_000);
      expect(value?.confirmed.map((member) => member.hostId).toSorted()).toEqual([b.hostId, c.hostId].toSorted());
    } finally {
      cleanup();
    }
  });

  test("an offline member does not confirm, and leave stops waiting at 30 s", async () => {
    const { b, clock, net, commands, cleanup } = threeMembers();
    try {
      net.offline("c");
      const { value, took } = await underClock(clock, commands.leave(), 40_000);
      expect(value?.confirmed.map((member) => member.hostId)).toEqual([b.hostId]);
      expect(took).toBeGreaterThanOrEqual(30_000);
    } finally {
      cleanup();
    }
  });

  test("with every member offline, leave confirms none and prints the revoke to run elsewhere", async () => {
    const { clock, net, commands, cleanup } = threeMembers();
    try {
      net.offline("b");
      net.offline("c");
      const { value } = await underClock(clock, commands.leave(), 40_000);
      expect(value?.confirmed).toEqual([]);
      expect(value?.revokeCommand).toBe("doriface-host mesh revoke a");
    } finally {
      cleanup();
    }
  });
});

const coreMember = (name: string): MemberEntry => ({
  signPub: `sign-${name}`,
  hostId: hostIdFor(name),
  noisePub: `noise-${name}`,
  devicePub: undefined,
  name,
  hcId: `core-${name}`,
});

/** This host's core holding the mesh machines of b and c, put there by a real reconciler, and `left()` over it. */
async function coreWithMachines(machines: FakeMachines) {
  const clock = new FakeClock();
  const self = coreMember("self");
  const reconciler = new Reconciler({
    machines,
    program: "/opt/doriface-host",
    stateDir: "/state",
    selfHostId: self.hostId,
    clock,
    log: () => undefined,
  });
  await reconciler.reconcile({ members: [self, coreMember("b"), coreMember("c")], revoked: [] });
  const runtime = { gossip: { stop: () => void machines.calls.push("gossip stopped") }, reconciler };
  const stopped: string[] = [];
  const sync = {
    gossip: undefined,
    runtime,
    changed: () => undefined,
    formatReady: () => false,
    live: () => NOT_RUNNING,
    stop: () => {
      stopped.push("sync");
      return Promise.resolve();
    },
  };
  return { left: () => syncHooks(sync, clock, () => []).left(), stopped };
}

/** A core whose `machine.rm` of b fails, as an unreachable or restarting herdr would. */
class StuckMachines extends FakeMachines {
  override rm(name: string): Promise<void> {
    return name === "b" ? Promise.reject(hcError("unreachable")) : super.rm(name);
  }
}

describe("mesh leave removes this host's mesh machines (design 6.5)", () => {
  test("gossip stops first, then every mesh machine leaves the core, then sync stops", async () => {
    const machines = new FakeMachines(new FakeClock());
    const { left, stopped } = await coreWithMachines(machines);
    await left();
    expect(await machines.list()).toEqual([]);
    expect(machines.calls.slice(machines.calls.indexOf("gossip stopped"))).toEqual([
      "gossip stopped",
      "0 rm b",
      "0 rm c",
    ]);
    expect(stopped).toEqual(["sync"]);
  });

  test("a mesh machine the core would not remove makes left() fail naming it, and sync still stops (M9)", async () => {
    const machines = new StuckMachines(new FakeClock());
    const { left, stopped } = await coreWithMachines(machines);
    await expect(left()).rejects.toThrow('"b"');
    expect((await machines.list()).map((machine) => machine.name)).toEqual(["b"]);
    expect(stopped).toEqual(["sync"]);
  });
});

test("the mesh hooks forward the records and the transaction's view to sync's format check (#2263)", () => {
  const seen: unknown[][] = [];
  const sync = {
    gossip: undefined,
    runtime: undefined,
    changed: () => undefined,
    stop: () => undefined,
    formatReady: (...args: unknown[]) => {
      seen.push(args);
      return true;
    },
    live: () => NOT_RUNNING,
  };
  const { records } = meshOf([peer("a")]);
  const view = viewOf(records);
  expect(syncHooks(sync, new FakeClock(), () => []).formatReady(records, view)).toBe(true);
  expect(seen).toEqual([[records, view]]);
});
