import { describe, expect, test } from "bun:test";
import { DialPolicy, type DueReason } from "./dial-policy.ts";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";

function reachedMember(): { clock: FakeClock; dials: DialPolicy; probes: () => readonly number[] } {
  const clock = new FakeClock();
  const due: { reason: DueReason; at: number }[] = [];
  const dials = new DialPolicy({
    clock,
    random: seededRandom(3),
    onDue: (_member, reason) => due.push({ reason, at: clock.now() }),
  });
  dials.report("m", "connected");
  return { clock, dials, probes: () => due.filter((entry) => entry.reason === "probe").map((entry) => entry.at) };
}

describe("the reconnect grace holds whatever else is going on (#2448)", () => {
  test("a reached member whose first refusal follows a rate limit is reconnecting, not offline", async () => {
    const { clock, dials } = reachedMember();
    dials.report("m", 4429);
    await clock.advance(30_000);
    dials.report("m", 4404);
    expect(dials.gate("m")).toMatchObject({ cause: "reconnecting", misses: 1, nextAt: 32_000 });
  });

  test("two dials refused at the same moment do not skip the retry at 2 s", async () => {
    const { clock, dials, probes } = reachedMember();
    dials.report("m", 4404);
    dials.report("m", 4404);
    expect(dials.gate("m")).toMatchObject({ cause: "reconnecting", misses: 1, nextAt: 2_000 });
    await clock.advance(5_000);
    expect(probes()).toEqual([2_000]);
  });

  test("a refusal before the retry is due leaves the schedule alone; only the retry's own refusal moves it on", async () => {
    const { clock, dials, probes } = reachedMember();
    dials.report("m", 4404);
    await clock.advance(1_000);
    dials.report("m", 4404);
    expect(dials.gate("m")).toMatchObject({ cause: "reconnecting", nextAt: 2_000 });
    await clock.advance(1_000);
    dials.report("m", 4404);
    expect(dials.gate("m")).toMatchObject({ cause: "reconnecting", nextAt: 5_000 });
    await clock.advance(1_000);
    dials.report("m", 4404);
    expect(dials.gate("m")).toMatchObject({ cause: "reconnecting", nextAt: 5_000 });
    await clock.advance(2_000);
    dials.report("m", 4404);
    expect(dials.gate("m")).toMatchObject({ cause: "offline", misses: 1, nextAt: 35_000 });
    expect(probes()).toEqual([2_000, 5_000]);
  });

  test("a member gated offline that is rate limited and then refuses stays on its backoff: it was not reached", async () => {
    const { clock, dials } = reachedMember();
    dials.report("m", 4404);
    await clock.advance(2_000);
    dials.report("m", 4404);
    await clock.advance(3_000);
    dials.report("m", 4404);
    expect(dials.gate("m")).toMatchObject({ cause: "offline", misses: 1 });
    dials.report("m", 4429);
    await clock.advance(30_000);
    dials.report("m", 4404);
    expect(dials.gate("m")).toMatchObject({ cause: "offline", misses: 2, nextAt: 95_000 });
  });
});
