import { describe, expect, test } from "bun:test";
import { DIAL_LIMITS, DialPolicy, type DueReason, type Grant } from "./dial-policy.ts";
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

/** When each probe came due. */
const probes = (due: readonly { reason: DueReason; at: number }[]): readonly number[] =>
  due.filter((entry) => entry.reason === "probe").map((entry) => entry.at);

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

  test("a refused relay pass (4412) gates nothing and halves nothing; the member is due when a new pass arrives", async () => {
    const { dials, due } = policy();
    dials.report("m", 4412);
    expect(dials.budget).toBe(12);
    expect(dials.gate("m")).toBeUndefined();
    expect(granted(await dials.acquire("m", "push"))).toBe(true);
    dials.passRenewed();
    dials.passRenewed();
    expect(due.filter((entry) => entry.member === "m").map((entry) => entry.reason)).toEqual(["pass"]);
  });

  test("a member refused for its pass is due after 30 s when no new pass comes, and only once", async () => {
    const { clock, dials, due } = policy();
    dials.report("m", 4412);
    dials.report("m", 4412);
    await clock.advance(29_999);
    expect(due.filter((entry) => entry.member === "m")).toEqual([]);
    await clock.advance(1);
    expect(due.filter((entry) => entry.member === "m").map((entry) => [entry.reason, entry.at])).toEqual([
      ["pass", 30_000],
    ]);
    dials.passRenewed();
    expect(due.filter((entry) => entry.member === "m")).toHaveLength(1);
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
      await clock.untilTimers(() => due.some((entry) => entry.reason === "probe" && entry.at > start), 300_000);
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

describe("a reached member that refuses a dial is reconnecting before it is offline (#2448)", () => {
  test("it is dialed again 2 s and 5 s after the first refusal, and gated offline only when that dial fails too", async () => {
    const { clock, dials, due } = policy();
    dials.report("m", "connected");
    dials.report("m", 4404);
    expect(dials.gate("m")?.cause).toBe("reconnecting");
    expect(await dials.acquire("m", "push")).toEqual({ ok: false, reason: "reconnecting", nextInMs: 2_000 });
    await clock.advance(2_000);
    expect(granted(await dials.acquire("m", "probe"))).toBe(true);
    dials.report("m", 4404);
    expect(dials.gate("m")?.cause).toBe("reconnecting");
    await clock.advance(3_000);
    expect(probes(due)).toEqual([2_000, 5_000]);
    expect(granted(await dials.acquire("m", "probe"))).toBe(true);
    dials.report("m", 4404);
    expect(dials.gate("m")).toMatchObject({ cause: "offline", misses: 1, nextAt: 35_000 });
  });

  test("a member that answers a retry is reached again: no gate, and no first miss left behind", async () => {
    const { clock, dials } = policy();
    dials.report("m", "connected");
    dials.report("m", 4404);
    await clock.advance(2_000);
    dials.report("m", "connected");
    expect(dials.gate("m")).toBeUndefined();
    expect(dials.unreachableSince("m")).toBeUndefined();
    expect(granted(await dials.acquire("m", "push"))).toBe(true);
  });

  test("a member that was never reached is gated offline at its first refusal, so a start spends no dials on retries", () => {
    const { dials } = policy();
    dials.report("m", 4404);
    expect(dials.gate("m")).toMatchObject({ cause: "offline", misses: 1, nextAt: 30_000 });
  });

  test("a member gated offline that is reached and then refuses gets the grace again", async () => {
    const { clock, dials } = policy();
    dials.report("m", 4404);
    await clock.advance(30_000);
    dials.report("m", "connected");
    dials.report("m", 4404);
    expect(dials.gate("m")).toMatchObject({ cause: "reconnecting", nextAt: 32_000 });
  });

  test("a rate limit met inside the grace does not count the grace's refusals as misses", async () => {
    const { clock, dials } = policy();
    dials.report("m", "connected");
    dials.report("m", 4404);
    dials.report("m", 4429);
    expect(dials.gate("m")).toMatchObject({ cause: "rate-limited", misses: 0 });
    await clock.advance(30_000);
    dials.report("m", 4404);
    expect(dials.gate("m")).toMatchObject({ cause: "offline", misses: 1, nextAt: 60_000 });
  });

  test("a reached member whose first refusal follows a rate limit still gets the grace (#2507)", async () => {
    const { clock, dials } = policy();
    dials.report("m", "connected");
    dials.report("m", 4429);
    await clock.advance(30_000);
    dials.report("m", 4404);
    expect(dials.gate("m")).toMatchObject({ cause: "reconnecting", misses: 1, nextAt: 32_000 });
  });

  test("two refusals at once keep the retry 2 s after the first (#2507)", async () => {
    const { clock, dials, due } = policy();
    dials.report("m", "connected");
    dials.report("m", 4404);
    dials.report("m", 4404);
    expect(dials.gate("m")).toMatchObject({ cause: "reconnecting", nextAt: 2_000 });
    await clock.advance(2_000);
    expect(probes(due)).toEqual([2_000]);
  });

  test("a reached member that refuses this host as revoked (4401) gets no grace (#2507)", () => {
    const { dials } = policy();
    dials.report("m", "connected");
    dials.report("m", 4401);
    expect(dials.gate("m")).toMatchObject({ cause: "offline", misses: 1, nextAt: 30_000 });
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

describe("a line refused for the budget (section 8.2, H-D1)", () => {
  test("is due again when the window frees, not on a later probe", async () => {
    const { clock, dials, due } = policy();
    await fill(dials, DIAL_LIMITS.budget);
    const refused = dials.acquire("late", "line", { waitMs: DIAL_LIMITS.lineWaitMs });
    await clock.advance(DIAL_LIMITS.lineWaitMs);
    const grant = await refused;
    expect(grant.ok === false && grant.reason).toBe("budget");
    expect(due.filter((entry) => entry.reason === "budget")).toEqual([]);
    await clock.advance(DIAL_LIMITS.windowMs - DIAL_LIMITS.lineWaitMs);
    expect(due.filter((entry) => entry.reason === "budget")).toEqual([
      { member: "late", reason: "budget", at: DIAL_LIMITS.windowMs },
    ]);
  });
});

describe("a revoked member that refuses the handshake (#2449)", () => {
  test("its refused gate is cleared by presence, should it show any (#2517 review)", () => {
    const { dials } = policy();
    dials.report("m", "refused");
    expect(dials.gate("m")?.cause).toBe("refused");
    dials.presence("m");
    expect(dials.gate("m")).toBeUndefined();
  });
});
