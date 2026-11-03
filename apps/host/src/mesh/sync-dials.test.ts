import { describe, expect, test } from "bun:test";
import type { MemberEntry } from "./authorize-index.ts";
import { DIAL_LIMITS } from "./dial-policy.ts";
import { FakeClock, seededRandom, settle } from "./testing/fake-clock.ts";
import { meshOf, peer } from "./testing/mesh-peers.ts";
import { MeshNet, type NetHost } from "./testing/mesh-net.ts";

const entryOf = (host: NetHost, signPub: string): MemberEntry => {
  const entry = host.gossip.view.members.find((member) => member.signPub === signPub);
  if (entry === undefined) throw new Error(`no member ${signPub}`);
  return entry;
};

function pair() {
  const [a, b] = [peer("a"), peer("b")];
  const clock = new FakeClock();
  const net = new MeshNet(clock, seededRandom(17));
  const { records } = meshOf([a, b]);
  const hostA = net.add(a, records);
  const hostB = net.add(b, records);
  return { clock, hostA, hostB, toB: entryOf(hostA, b.signPub), toA: entryOf(hostB, a.signPub) };
}

describe("one dial per member at a time (section 8.2, H-D1)", () => {
  test("a push and a sweep for the same member share one dial and one budget token", async () => {
    const { hostA, toB } = pair();
    const before = hostA.dials.length;
    const results = await Promise.all([hostA.gossip.sync(toB, "push"), hostA.gossip.sync(toB, "sweep")]);
    expect(results).toEqual([true, true]);
    expect(hostA.dials.length - before).toBe(1);
  });

  test("a session that came up while the dial waited for a token is used, and the token goes back", async () => {
    const { clock, hostA, hostB, toB, toA } = pair();
    await Promise.all(
      Array.from({ length: DIAL_LIMITS.budget }, (_, i) => hostA.policy.acquire(`filler-${i}`, "push")),
    );
    const before = hostA.dials.length;
    const waiting = hostA.gossip.sync(toB, "push");
    await hostB.gossip.sync(toA, "push");
    await settle();
    await clock.advance(DIAL_LIMITS.windowMs);
    expect(await waiting).toBe(true);
    expect(hostA.dials.length).toBe(before);
    const grants = await Promise.all(
      Array.from({ length: DIAL_LIMITS.budget }, (_, i) => hostA.policy.acquire(`after-${i}`, "push", { waitMs: 0 })),
    );
    expect(grants.filter((grant) => grant.ok)).toHaveLength(DIAL_LIMITS.budget);
  });
});
