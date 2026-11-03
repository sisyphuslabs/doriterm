import { describe, expect, test } from "bun:test";
import { DialPolicy, type DueReason } from "./dial-policy.ts";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import { fakeRules, meshOf, member } from "./testing/fake-mesh.ts";
import { MeshNet } from "./testing/mesh-net.ts";

function policy(): { clock: FakeClock; dials: DialPolicy; due: { member: string; reason: DueReason; at: number }[] } {
  const clock = new FakeClock();
  const due: { member: string; reason: DueReason; at: number }[] = [];
  const dials = new DialPolicy({
    clock,
    random: seededRandom(5),
    onDue: (target, reason) => due.push({ member: target, reason, at: clock.now() }),
  });
  return { clock, dials, due };
}

function net(): { clock: FakeClock; mesh: MeshNet } {
  const clock = new FakeClock();
  const mesh = new MeshNet(clock, seededRandom(17));
  const members = ["a", "b", "c", "d"].map(member);
  const base = meshOf(members);
  for (const entry of members) mesh.add(entry, base);
  return { clock, mesh };
}

describe("this host's own outage drops only the 4404s it saw while down (section 8.2)", () => {
  test("a gate from before the outage survives the return, with its misses and first-miss time", async () => {
    const { clock, dials } = policy();
    dials.report("dead", 4404);
    await clock.advance(30_000);
    dials.report("dead", 4404);
    await clock.advance(60_000);
    const downSince = clock.now();
    await clock.advance(1_000);
    dials.uplinkReturned(["dead"], downSince);
    expect(dials.gate("dead")?.misses).toBe(2);
    expect(dials.unreachableSince("dead")).toBe(0);
  });

  test("a member first missed before the outage and again during it is ungated, and keeps its first-miss time", async () => {
    const { clock, dials } = policy();
    dials.report("m", 4404);
    await clock.advance(120_000);
    const downSince = clock.now();
    dials.report("m", 4404);
    dials.report("fresh", 4404);
    await clock.advance(30_000);
    dials.uplinkReturned(["m", "fresh"], downSince);
    expect(dials.gate("m")).toBeUndefined();
    expect(dials.unreachableSince("m")).toBe(0);
    expect(dials.gate("fresh")).toBeUndefined();
    expect(dials.unreachableSince("fresh")).toBeUndefined();
  });

  test("a 4404 seen during a 20 s drop is dropped on return; a member gated before it stays gated", async () => {
    const { clock, mesh } = net();
    const d = mesh.host("d");
    const [a, b] = [mesh.host("a").member, mesh.host("b").member];
    mesh.offline("b");
    await d.gossip.sync(b, "push");
    await clock.advance(35_000);
    expect(d.policy.gate(b.signPub)?.misses).toBe(2);
    mesh.offline("d");
    await d.gossip.sync(a, "push");
    expect(d.policy.gate(a.signPub)).toBeDefined();
    await clock.advance(20_000);
    mesh.online("d");
    d.gossip.uplinkReturned(20_000);
    expect(d.policy.gate(a.signPub)).toBeUndefined();
    expect(d.policy.gate(b.signPub)?.misses).toBe(2);
  });
});

describe("a gated member's due probe (section 8.2)", () => {
  test("a line to a gated member is refused until its probe is due, then goes as that probe", async () => {
    const { clock, dials } = policy();
    dials.report("m", 4404);
    await clock.advance(29_999);
    expect((await dials.acquire("m", "line")).ok).toBe(false);
    await clock.advance(1);
    expect((await dials.acquire("m", "line")).ok).toBe(true);
  });
});

describe("a 4429 and other failed dials (section 8.2)", () => {
  test("a 4429 gates the member as rate limited: refused for 30 s, then probed", async () => {
    const { clock, dials, due } = policy();
    dials.report("m", 4429);
    expect(await dials.acquire("m", "push")).toEqual({ ok: false, reason: "rate-limited", nextInMs: 30_000 });
    await clock.advance(30_000);
    expect(due).toEqual([{ member: "m", reason: "probe", at: 30_000 }]);
  });

  test("a dial that fails without a close code gates the member, and its probe delivers what it is owed", async () => {
    const { clock, mesh } = net();
    const a = mesh.host("a");
    const d = mesh.host("d");
    mesh.breakDials("d");
    const [admit] = a.gossip.local([a.signer.admit(member("e"), fakeRules.headsOf(a.file.read().records))]).added;
    await clock.advance(1_000);
    expect(a.policy.gate(d.member.signPub)?.misses).toBe(1);
    mesh.mendDials("d");
    const has = (): boolean => d.file.read().records.some((record) => record.body === admit?.body);
    const took = await clock.until(has, 35_000);
    expect(took).toBeGreaterThanOrEqual(29_000);
  });
});
