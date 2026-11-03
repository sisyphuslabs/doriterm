import { describe, expect, test } from "bun:test";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import { fakeRules, meshOf, member } from "./testing/fake-mesh.ts";
import { MeshNet } from "./testing/mesh-net.ts";

function mesh(names: readonly string[]): { clock: FakeClock; net: MeshNet } {
  const clock = new FakeClock();
  const net = new MeshNet(clock, seededRandom(23));
  const members = names.map(member);
  const base = meshOf(members);
  for (const entry of members) net.add(entry, base);
  return { clock, net };
}

describe("sync sessions (section 5.1)", () => {
  test("when both ends dial at once, both keep the session the smaller hostId dialed", async () => {
    const { clock, net } = mesh(["a", "b"]);
    const [a, b] = [net.host("a"), net.host("b")];
    await Promise.all([a.gossip.sync(b.member, "push"), b.gossip.sync(a.member, "push")]);
    await clock.advance(1_000);
    expect(a.gossip.session(b.member.signPub)?.dialer).toBe(a.member.signPub);
    expect(b.gossip.session(a.member.signPub)?.dialer).toBe(a.member.signPub);
  });

  test("after merging a push, a member says its new heads, so the pusher owes only the new, unreached member", async () => {
    const { clock, net } = mesh(["a", "b", "c", "d"]);
    const a = net.host("a");
    a.gossip.local([a.signer.admit(member("e"), fakeRules.headsOf(a.file.read().records))]);
    await clock.advance(2_000);
    expect(net.converged()).toBe(true);
    expect(a.gossip.owed().map((entry) => entry.name)).toEqual(["e"]);
  });

  test("with nothing else to wake it, the safety net syncs one member every 10 minutes give or take 2", async () => {
    const { clock, net } = mesh(["a", "b", "c"]);
    const a = net.host("a");
    a.file.transact((state) => {
      const record = a.signer.name(fakeRules.headsOf(state.records), "a2");
      return { state: { ...state, records: [...state.records, record] }, result: undefined };
    });
    await clock.advance(8 * 60_000 - 1);
    expect(net.converged()).toBe(false);
    const took = await clock.until(() => net.converged(), 30 * 60_000, 10_000);
    expect(took).toBeLessThanOrEqual(24 * 60_000);
  });
});
