import { afterAll, describe, expect, test } from "bun:test";
import { DialPolicy } from "./dial-policy.ts";
import { LineGrants } from "./line-grants.ts";
import { Reconciler, STUCK_RETRY_MS } from "./reconciler.ts";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import {
  addOverSsh,
  type Core,
  dialCore,
  directVia,
  hostIdFor,
  localHost,
  recorded,
  sshTo,
  startCore,
  startCoreWith,
} from "./testing/hc-mesh.ts";
import { fallbacks } from "@doriface/mesh";
import type { MemberEntry } from "./authorize-index.ts";
import type { MeshView } from "./mesh-view.ts";
import type { MachineView } from "@doriface/protocol";
import { meshHostOf, meshVia } from "./via.ts";

const LONG = 60_000;
const started: Core[] = [];
/** Each mesh's own core, whose machines dial the other cores. */
const dialers = new Set<Core>();
const locals: { dispose(): void }[] = [];
afterAll(async () => {
  for (const local of locals) local.dispose();
  // A dialer reconnects a machine whose core stopped, and its `hc connect` starts that core again: dialers stop first.
  await Promise.all([...dialers].map((core) => core.dispose()));
  await Promise.all(started.filter((core) => !dialers.has(core)).map((core) => core.dispose()));
});

const shapeOf = (m: MachineView) => [m.name, m.id, m.target, m.via ?? false, m.session ?? null];
const viewOf = (...members: readonly MemberEntry[]): MeshView => ({ members, revoked: [] });
const fakeMember = (name: string): MemberEntry => ({
  signPub: `sign-${name}`,
  hostId: hostIdFor(name),
  noisePub: `noise-${name}`,
  devicePub: undefined,
  name,
  hcId: `hc-${name}`,
});

async function cores(...names: readonly string[]): Promise<readonly Core[]> {
  const made = await Promise.all(names.map(startCore));
  started.push(...made);
  return made;
}

/** `sshTarget` names the member `self`'s `ssh` reaches, so a test can add that member over ssh. */
async function mesh(names: readonly string[], sshTarget?: string) {
  const members = await cores(...names);
  const reach = members.find((core) => core.member.name === sshTarget);
  const shim = reach === undefined ? undefined : sshTo(reach);
  if (shim !== undefined) locals.push(shim);
  const self = await startCoreWith("self", shim?.env ?? {});
  started.push(self);
  dialers.add(self);
  const local = localHost();
  locals.push(local);
  const clock = new FakeClock();
  let current = viewOf(self.member, ...members.map((core) => core.member));
  const policy = new DialPolicy({ clock, random: seededRandom(5), onDue: () => undefined });
  await local.serve(new LineGrants({ view: () => current, policy, dial: dialCore(members) }));
  const machines = recorded(self.control.machines);
  const reconciler = new Reconciler({
    machines,
    program: local.program,
    stateDir: local.stateDir,
    selfHostId: self.member.hostId,
    clock,
    log: () => undefined,
  });
  const run = (view: MeshView): Promise<void> => {
    current = view;
    return reconciler.reconcile(view);
  };
  const list = () => self.control.machines.list();
  return { self, members, local, clock, machines, reconciler, run, list };
}

describe("the reconciler against real hc (R-1, R-2, R-9, R-10, R-11)", () => {
  test(
    "adds every member concurrently with the pinned quoted via, and a second run calls nothing",
    async () => {
      const { self, members, local, machines, run, list } = await mesh(["b", "c"]);
      await run(viewOf(self.member, ...members.map((core) => core.member)));
      const listed = await list();
      expect(listed.map((m) => m.name).toSorted()).toEqual(["b", "c"]);
      for (const machine of listed) {
        expect(machine.target).toBe(meshVia(local.program, local.stateDir, hostIdFor(machine.name)));
        expect(machine.target).toContain(`'\\''`);
      }
      expect(machines.maxConcurrentAdds()).toBe(2);
      expect((await self.control.machines.connect("b")).state).toBe("connected");
      machines.calls.length = 0;
      await run(viewOf(self.member, ...members.map((core) => core.member)));
      expect(machines.calls).toEqual([]);
    },
    LONG,
  );

  test(
    "removes before it adds, renames by via, and falls back to <name>-<hostId> when the name is taken",
    async () => {
      const { self, members, machines, run, list } = await mesh(["b", "c", "d"]);
      const [b, c, d] = members;
      const [squatter] = await cores("sq");
      if (b === undefined || c === undefined || d === undefined || squatter === undefined) throw new Error("cores");
      await run(viewOf(self.member, b.member, c.member));
      await self.control.machines.add("d", directVia(squatter));
      machines.calls.length = 0;
      await run(viewOf(self.member, { ...b.member, name: "b2" }, d.member));
      const fallback = fallbacks("d", d.member.hostId)[0] ?? "";
      expect(machines.calls).toEqual(["rm c", "rename b b2", "add d", `add ${fallback}`]);
      expect((await list()).map((m) => m.name).toSorted()).toEqual(["b2", "d", fallback].toSorted());
    },
    LONG,
  );

  test(
    "an invalid name herdr refuses is STUCK invalid_name, not retried for 10 minutes",
    async () => {
      const { self, machines, reconciler, clock, run } = await mesh([]);
      const bad = fakeMember("Bad");
      await run(viewOf(self.member, bad));
      const status = reconciler.status.get(bad.hostId);
      expect(status?.state).toBe("stuck");
      // herdr's own name refusal is read as a name problem, never as a refused via (#1582).
      expect(status?.state === "stuck" && status.reason.startsWith('invalid_name: herdr refused "Bad"')).toBe(true);
      expect(machines.calls).toEqual(["add Bad"]);
      await run(viewOf(self.member, bad));
      await clock.advance(STUCK_RETRY_MS - 1);
      await reconciler.idle();
      expect(machines.calls).toEqual(["add Bad"]);
      await clock.advance(1);
      await reconciler.idle();
      expect(machines.calls).toEqual(["add Bad", "add Bad"]);
    },
    LONG,
  );

  test(
    "all fallbacks taken is STUCK name_taken, retried when the view changes",
    async () => {
      const { self, machines, reconciler, run } = await mesh([]);
      const e = fakeMember("e");
      const names = ["e", ...fallbacks("e", e.hostId)];
      const squatters = await cores("s1", "s2", "s3", "s4");
      await Promise.all(squatters.map((core, i) => self.control.machines.add(names[i] ?? "x", directVia(core))));
      await run(viewOf(self.member, e));
      const status = reconciler.status.get(e.hostId);
      expect(status?.state === "stuck" && status.reason.startsWith("name_taken")).toBe(true);
      expect(machines.calls).toEqual(names.map((name) => `add ${name}`));
      await run(viewOf(self.member, e));
      expect(machines.calls.length).toBe(4);
      await run(viewOf(self.member, e, fakeMember("g")));
      expect(machines.calls.filter((call) => call === "add e").length).toBe(2);
    },
    LONG,
  );

  test(
    "a member's core already added over ssh is migrated to the mesh line, and the note says it was ssh",
    async () => {
      const { self, members, local, reconciler, run, list } = await mesh(["b"], "b");
      const [b] = members;
      if (b === undefined) throw new Error("core");
      await addOverSsh(self, "old", "build-box");
      expect((await list()).map((m) => [m.name, m.via ?? false, m.id])).toEqual([["old", false, b.control.coreId]]);
      await run(viewOf(self.member, b.member));
      const listed = await list();
      expect(listed.map((m) => m.name)).toEqual(["b"]);
      expect(meshHostOf(listed[0]?.target ?? "", local.program, local.stateDir)).toBe(b.member.hostId);
      expect(reconciler.status.get(b.member.hostId)).toEqual({ state: "ok", replaced: { name: "old", kind: "ssh" } });
    },
    LONG,
  );

  test(
    "an entry added back after a failed migration is listed as it was, over ssh and with a via",
    async () => {
      const { self, members, list } = await mesh(["b", "c"], "b");
      const [b, c] = members;
      if (b === undefined || c === undefined) throw new Error("cores");
      await addOverSsh(self, "old", "build-box");
      await self.control.machines.add("other", directVia(c));
      const before = (await list()).map(shapeOf).toSorted();
      await Promise.all(
        (await list()).map(async (machine) => {
          await self.control.machines.rm(machine.name);
          await self.control.machines.restore(machine);
        }),
      );
      expect((await list()).map(shapeOf).toSorted()).toEqual(before);
    },
    LONG,
  );

  test(
    "an earlier entry that holds the member's name hands it to the mesh line instead of a fallback",
    async () => {
      const { self, members, local, machines, reconciler, run, list } = await mesh(["b"], "b");
      const [b] = members;
      if (b === undefined) throw new Error("core");
      await addOverSsh(self, "b", "build-box");
      machines.calls.length = 0;
      await run(viewOf(self.member, b.member));
      const fallback = fallbacks("b", b.member.hostId)[0] ?? "";
      expect(machines.calls).toEqual(["add b", `add ${fallback}`, "rm b", "add b"]);
      const listed = await list();
      expect(listed.map((m) => [m.name, m.id])).toEqual([["b", b.control.coreId]]);
      expect(meshHostOf(listed[0]?.target ?? "", local.program, local.stateDir)).toBe(b.member.hostId);
      expect(reconciler.status.get(b.member.hostId)).toEqual({ state: "ok", replaced: { name: "b", kind: "ssh" } });
    },
    LONG,
  );

  test(
    "a member's core already added with a via command is migrated to the mesh line, and the note says it was a command",
    async () => {
      const { self, members, local, reconciler, run, list } = await mesh(["b"]);
      const [b] = members;
      if (b === undefined) throw new Error("core");
      await self.control.machines.add("old", directVia(b));
      await run(viewOf(self.member, b.member));
      const listed = await list();
      expect(listed.map((m) => m.name)).toEqual(["b"]);
      expect(meshHostOf(listed[0]?.target ?? "", local.program, local.stateDir)).toBe(b.member.hostId);
      expect(reconciler.status.get(b.member.hostId)).toEqual({
        state: "ok",
        replaced: { name: "old", kind: "command" },
      });
    },
    LONG,
  );
});
