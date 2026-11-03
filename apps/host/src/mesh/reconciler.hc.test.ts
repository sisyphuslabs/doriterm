import { afterAll, describe, expect, test } from "bun:test";
import { DialPolicy } from "./dial-policy.ts";
import { LineGrants } from "./line-grants.ts";
import { Reconciler, STUCK_RETRY_MS } from "./reconciler.ts";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import { type Core, dialCore, directVia, hostIdFor, localHost, recorded, startCore } from "./testing/hc-mesh.ts";
import { fallbacks } from "@doriface/mesh";
import type { MemberEntry } from "./authorize-index.ts";
import type { MeshView } from "./mesh-view.ts";
import { meshHostOf, meshVia } from "./via.ts";

const LONG = 60_000;
const started: Core[] = [];
const locals: ReturnType<typeof localHost>[] = [];
afterAll(async () => {
  for (const local of locals) local.dispose();
  await Promise.all(started.map((core) => core.dispose()));
});

const viewOf = (...members: readonly MemberEntry[]): MeshView => ({ members, overCap: [], revoked: [] });
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

async function mesh(names: readonly string[]) {
  const [self, ...members] = await cores("self", ...names);
  if (self === undefined) throw new Error("no core");
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
      expect(reconciler.status.get(bad.hostId)?.state).toBe("stuck");
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
    "a member's core already added with plain doriface-host connect is migrated to the mesh line",
    async () => {
      const { self, members, local, reconciler, run, list } = await mesh(["b"]);
      const [b] = members;
      if (b === undefined) throw new Error("core");
      await self.control.machines.add("old", directVia(b));
      await run(viewOf(self.member, b.member));
      const listed = await list();
      expect(listed.map((m) => m.name)).toEqual(["b"]);
      expect(meshHostOf(listed[0]?.target ?? "", local.program, local.stateDir)).toBe(b.member.hostId);
      const status = reconciler.status.get(b.member.hostId);
      expect(status?.state === "ok" && status.note).toBe(
        'replaced machine "old" (doriface-host connect) with the mesh line',
      );
    },
    LONG,
  );
});
