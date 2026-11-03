import { afterAll, describe, expect, test } from "bun:test";
import type { ByteLink } from "@doriface/crypto";
import { MeshDriver } from "./driver.ts";
import { MeshLines } from "./mesh-lines.ts";
import { Reconciler } from "./reconciler.ts";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import { fakeRules, meshOf } from "./testing/fake-mesh.ts";
import { type Core, dialCore, localHost, startCore } from "./testing/hc-mesh.ts";
import { MeshNet } from "./testing/mesh-net.ts";
import type { MeshMember } from "./upstream.ts";
import { meshHostOf } from "./via.ts";

const started: Core[] = [];
const local = localHost();
afterAll(async () => {
  local.dispose();
  await Promise.all(started.map((core) => core.dispose()));
});

describe("machines follow the mesh by themselves (goal 1 and 2, R-13)", () => {
  test("an admission elsewhere adds the machine through connect --mesh; a revocation removes it and closes its line", async () => {
    const [a, b, e] = await Promise.all(["a", "b", "e"].map(startCore));
    if (a === undefined || b === undefined || e === undefined) throw new Error("cores");
    started.push(a, b, e);
    const clock = new FakeClock();
    const net = new MeshNet(clock, seededRandom(17));
    const base = meshOf([a.member, b.member]);
    const opened = new Map<string, ByteLink[]>();
    const dial = dialCore([b, e]);
    const recordLink = async (member: MeshMember): Promise<ByteLink> => {
      const link = await dial(member);
      opened.set(member.name, [...(opened.get(member.name) ?? []), link]);
      return link;
    };
    const closed: string[] = [];
    const reconciler = new Reconciler({
      machines: a.control.machines,
      program: local.program,
      stateDir: local.stateDir,
      selfHostId: a.member.hostId,
      clock,
      log: () => undefined,
    });
    const holder: { driver?: MeshDriver } = {};
    const hostA = net.add(
      a.member,
      base,
      (view) => void holder.driver?.viewChanged(view),
      (member, reason) => void holder.driver?.due(member, reason),
    );
    const lines = new MeshLines({ view: () => hostA.gossip.view, policy: hostA.policy, dial: recordLink });
    local.serve(lines);
    holder.driver = new MeshDriver({ reconciler, lines, policy: hostA.policy, view: hostA.gossip.view });
    const hostB = net.add(b.member, base);
    net.add(e.member, base);
    await holder.driver.start();
    const names = async (): Promise<readonly string[]> =>
      (await a.control.machines.list())
        .filter((m) => meshHostOf(m.target, local.program, local.stateDir) !== undefined)
        .map((m) => m.name)
        .toSorted();
    expect(await names()).toEqual(["b"]);

    hostB.gossip.local([hostB.signer.admit(e.member, fakeRules.headsOf(hostB.file.read().records))]);
    await clock.advance(5_000);
    await reconciler.idle();
    expect(await names()).toEqual(["b", "e"]);
    expect((await a.control.machines.connect("e")).state).toBe("connected");
    for (const link of opened.get("e") ?? []) link.onClose(() => closed.push("e"));

    hostB.gossip.append((prev) => ({ type: "revoke", prev, signPubs: [e.member.signPub], reason: "revoke" }));
    await clock.advance(15_000);
    await reconciler.idle();
    expect(await names()).toEqual(["b"]);
    expect(closed.length).toBeGreaterThan(0);
  }, 60_000);
});
