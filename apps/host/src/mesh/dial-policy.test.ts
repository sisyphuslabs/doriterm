import { describe, expect, test } from "bun:test";
import { DialPolicy, type DueReason, type Grant } from "./dial-policy.ts";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";

function policy(): { clock: FakeClock; dials: DialPolicy; due: { member: string; reason: DueReason; at: number }[] } {
  const clock = new FakeClock();
  const due: { member: string; reason: DueReason; at: number }[] = [];
  const dials = new DialPolicy({
    clock,
    random: seededRandom(3),
    onDue: (member, reason) => due.push({ member, reason, at: clock.now() }),
  });
  return { clock, dials, due };
}

const granted = (grant: Grant | undefined): boolean => grant?.ok === true;

/** Takes `count` tokens at once: each acquire is charged synchronously while the window has room. */
const fill = async (dials: DialPolicy, count: number): Promise<readonly Grant[]> =>
  Promise.all(Array.from({ length: count }, (_, i) => dials.acquire(`m${i}`, "push")));

describe("the dial budget (S-4)", () => {
  test("12 relay upgrades per sliding 60 s: the 13th waits for the oldest to leave the window", async () => {
    const { clock, dials } = policy();
    expect((await fill(dials, 12)).every(granted)).toBe(true);
    let thirteenth: Grant | undefined;
    void dials.acquire("m12", "push").then((grant) => (thirteenth = grant));
    await clock.advance(59_999);
    expect(thirteenth).toBeUndefined();
    await clock.advance(1);
    expect(granted(thirteenth)).toBe(true);
  });

  test("waiters are served by priority: a revoke push before a line, whatever came first", async () => {
    const { clock, dials } = policy();
    await fill(dials, 12);
    const order: string[] = [];
    void dials.acquire("line-target", "line").then(() => order.push("line"));
    void dials.acquire("revoked", "revoke-push").then(() => order.push("revoke-push"));
    await clock.advance(60_000);
    expect(order).toEqual(["revoke-push", "line"]);
  });

  test("a 4429 halves the budget for 10 minutes", async () => {
    const { clock, dials } = policy();
    dials.report("x", 4429);
    expect(dials.budget).toBe(6);
    expect((await fill(dials, 6)).every(granted)).toBe(true);
    const seventh = dials.acquire("m6", "push", { waitMs: 1_000 });
    await clock.advance(1_000);
    expect(await seventh).toEqual({ ok: false, reason: "budget" });
    await clock.advance(600_000);
    expect(dials.budget).toBe(12);
  });

  test("a direct (LAN) dial is never charged", async () => {
    const { dials } = policy();
    await fill(dials, 12);
    expect(granted(await dials.acquire("lan", "push", { direct: true }))).toBe(true);
  });
});

describe("gating after 4404 (S-5)", () => {
  test("no redial until presence or a due probe; probes double from 30 s to a 5-minute ceiling", async () => {
    const { clock, dials, due } = policy();
    const starts: number[] = [];
    const miss = async (left: number): Promise<void> => {
      if (left === 0) return;
      dials.report("m", 4404);
      const start = clock.now();
      starts.push(start);
      expect((await dials.acquire("m", "push")).ok).toBe(false);
      await clock.until(() => due.some((entry) => entry.reason === "probe" && entry.at > start), 300_000, 1_000);
      expect(granted(await dials.acquire("m", "probe"))).toBe(true);
      return miss(left - 1);
    };
    await miss(6);
    const waits = due.filter((entry) => entry.reason === "probe").map((entry, i) => entry.at - (starts[i] ?? 0));
    expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
  });

  test("presence ungates the member and asks for a dial within 0-2 s", async () => {
    const { clock, dials, due } = policy();
    dials.report("m", 4404);
    dials.presence("m");
    expect(dials.gate("m")).toBeUndefined();
    await clock.advance(2_000);
    const presence = due.find((entry) => entry.reason === "presence");
    expect(presence?.at).toBeGreaterThanOrEqual(0);
    expect(presence?.at).toBeLessThan(2_000);
    expect(granted(await dials.acquire("m", "push"))).toBe(true);
  });
});

describe("settle after this host's own outage (S-6)", () => {
  test("lines to members without presence wait 10-20 s; a member that showed presence is dialed at once", async () => {
    const { clock, dials, due } = policy();
    dials.report("quiet", 4404);
    dials.uplinkReturned(() => ["quiet", "seen"], 0);
    dials.presence("seen");
    expect(granted(await dials.acquire("seen", "line"))).toBe(true);
    const waiting = await dials.acquire("quiet", "line");
    expect(waiting.ok === false && waiting.reason).toBe("settling");
    await clock.advance(20_000);
    const settled = due.filter((entry) => entry.reason === "settle");
    expect(settled.map((entry) => entry.member)).toEqual(["quiet"]);
    expect(settled[0]?.at).toBeGreaterThanOrEqual(10_000);
    expect(granted(await dials.acquire("quiet", "line"))).toBe(true);
  });

  test("a member admitted during the settle is due when it ends, not on a later probe", async () => {
    const { clock, dials, due } = policy();
    const members = ["old"];
    dials.uplinkReturned(() => members, 0);
    members.push("joined");
    const refused = await dials.acquire("joined", "line");
    expect(refused.ok === false && refused.reason).toBe("settling");
    await clock.advance(20_000);
    expect(due.filter((entry) => entry.reason === "settle").map((entry) => entry.member)).toEqual(["old", "joined"]);
  });
});
