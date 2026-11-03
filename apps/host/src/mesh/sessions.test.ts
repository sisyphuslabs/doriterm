import { describe, expect, test } from "bun:test";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import { headsOfRecords, meshOf, peer } from "./testing/mesh-peers.ts";
import { MeshNet } from "./testing/mesh-net.ts";

function mesh(names: readonly string[]): { clock: FakeClock; net: MeshNet } {
  const clock = new FakeClock();
  const net = new MeshNet(clock, seededRandom(23));
  const members = names.map(peer);
  const { records } = meshOf(members);
  for (const entry of members) net.add(entry, records);
  return { clock, net };
}

describe("sync sessions (section 5.1)", () => {
  test("when both ends want to sync at once, they share one session and one dial", async () => {
    const { clock, net } = mesh(["a", "b"]);
    const [a, b] = [net.host("a"), net.host("b")];
    const before = a.dials.length + b.dials.length;
    await Promise.all([a.gossip.sync(b.member, "push"), b.gossip.sync(a.member, "push")]);
    await clock.advance(1_000);
    expect(a.dials.length + b.dials.length - before).toBe(1);
    expect(a.gossip.session(b.member.signPub)?.dialer).toBe(b.gossip.session(a.member.signPub)?.dialer);
  });

  test("when two sessions are up between a pair, both ends keep the one the smaller hostId dialed", async () => {
    const { clock, net } = mesh(["a", "b"]);
    const [a, b] = [net.host("a"), net.host("b")];
    for (const dialer of [a, b]) {
      const [atA, atB] = memoryLinkPair(true);
      a.gossip.attach(b.member.signPub, dialer.member.signPub, atA);
      b.gossip.attach(a.member.signPub, dialer.member.signPub, atB);
    }
    await clock.advance(1_000);
    const smaller = a.member.hostId < b.member.hostId ? a.member.signPub : b.member.signPub;
    expect(a.gossip.session(b.member.signPub)?.dialer).toBe(smaller);
    expect(b.gossip.session(a.member.signPub)?.dialer).toBe(smaller);
  });

  test("after merging a push, a member says its new heads, so the pusher owes only the new, unreached member", async () => {
    const { clock, net } = mesh(["a", "b", "c", "d"]);
    const a = net.host("a");
    a.admit(peer("e"));
    await clock.advance(2_000);
    expect(net.converged()).toBe(true);
    expect(a.gossip.owed().map((entry) => entry.name)).toEqual(["e"]);
  });

  test("with nothing else to wake it, the safety net syncs one member every 10 minutes give or take 2", async () => {
    const { clock, net } = mesh(["a", "b", "c"]);
    const a = net.host("a");
    a.store.sign(a.member.machine.identity, (n, prev) => ({
      v: 2,
      mesh: a.gossip.meshId,
      type: "name",
      by: a.member.signPub,
      n,
      prev,
      subject: { signPub: a.member.signPub, name: "a2" },
    }));
    expect(headsOfRecords(a.records()).length).toBe(1);
    await clock.advance(8 * 60_000 - 1);
    expect(net.converged()).toBe(false);
    const took = await clock.until(() => net.converged(), 30 * 60_000, 10_000);
    expect(took).toBeLessThanOrEqual(24 * 60_000);
  });
});
