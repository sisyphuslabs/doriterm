import { describe, expect, test } from "bun:test";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import { fakeRules, meshOf, member } from "./testing/fake-mesh.ts";
import { MeshNet, type NetHost, setOf } from "./testing/mesh-net.ts";

const SEED = 20261103;
const names = (host: NetHost): readonly string[] =>
  fakeRules
    .viewOf(host.file.read().records)
    .members.map((entry) => entry.name)
    .toSorted();
const heads = (host: NetHost): readonly string[] => fakeRules.headsOf(host.file.read().records);

function fourHosts(): { clock: FakeClock; net: MeshNet } {
  const clock = new FakeClock();
  const net = new MeshNet(clock, seededRandom(SEED));
  const members = ["a", "b", "c", "d"].map(member);
  const base = meshOf(members);
  for (const entry of members) net.add(entry, base);
  return { clock, net };
}

describe("machine sync converges by itself (goal 2)", () => {
  test("after a partition heals, every host holds every record and computes the same view", async () => {
    const { clock, net } = fourHosts();
    net.partition(["a", "b"], ["c", "d"]);
    const a = net.host("a");
    const c = net.host("c");
    a.gossip.local([a.signer.admit(member("e"), heads(a))]);
    c.gossip.local([c.signer.admit(member("f"), heads(c))]);
    await clock.advance(5_000);
    expect(names(net.host("b"))).toEqual(["a", "b", "c", "d", "e"]);
    expect(names(net.host("d"))).toEqual(["a", "b", "c", "d", "f"]);
    expect(net.converged()).toBe(false);

    net.heal();
    const took = await clock.until(() => net.converged(), 6 * 60_000);
    console.log(`partition: converged ${took} ms (virtual) after the heal, no manual step`);
    for (const host of net.hosts.values()) expect(names(host)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  test("a host offline for hours catches up within 65 s of its uplink answering, and delivers what it wrote", async () => {
    const { clock, net } = fourHosts();
    const d = net.host("d");
    net.offline("d");
    const a = net.host("a");
    a.gossip.local([a.signer.admit(member("e"), heads(a))]);
    d.gossip.local([d.signer.admit(member("g"), heads(d))]);
    await clock.advance(6 * 60 * 60_000);
    expect(names(d)).toEqual(["a", "b", "c", "d", "g"]);

    net.online("d");
    d.gossip.uplinkReturned(6 * 60 * 60_000);
    // The return sweep runs at once; every other dial back waits the settle (at least 10 s).
    const swept = await clock.until(() => names(d).includes("e"), 9_999);
    const took = await clock.until(() => net.converged(), 65_000);
    console.log(`return: what d missed arrived ${swept} ms after the uplink answered`);
    console.log(`return: converged ${took} ms (virtual) after the uplink answered`);
    for (const host of net.hosts.values()) expect(names(host)).toEqual(["a", "b", "c", "d", "e", "g"]);
  });

  test("an admission and a revocation reach every online member's view within the 48 s bound", async () => {
    const { clock, net } = fourHosts();
    const b = net.host("b");
    b.gossip.local([b.signer.admit(member("e"), heads(b))]);
    const added = await clock.until(() => [...net.hosts.values()].every((host) => names(host).includes("e")), 48_000);
    const a = net.host("a");
    a.gossip.append((prev) => ({ type: "revoke", prev, signPubs: [member("c").signPub], reason: "revoke" }));
    const removed = await clock.until(
      () => [...net.hosts.values()].every((host) => !names(host).includes("c")),
      48_000,
    );
    console.log(`propagation: admit everywhere in ${added} ms, revoke everywhere in ${removed} ms (virtual)`);
    expect(setOf(net.host("c"))).toEqual(setOf(a));
  });
});
