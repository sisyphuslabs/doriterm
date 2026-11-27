import { afterEach, describe, expect, jest, test } from "bun:test";
import { DialBudget } from "./resume-dial-budget.ts";
import { RESUME_BACKOFF_MS, SessionResumer } from "./session-resume.ts";
import { fakeSession, settle, turns } from "./session-resume.test-support.ts";

afterEach(() => jest.useRealTimers());

describe("SessionResumer's ladder and budget", () => {
  test("a wake gives the resume its whole budget again: time the page spent hidden or frozen does not use it up (#2853)", async () => {
    const { session, calls } = fakeSession(["refused", "refused", "ok"]);
    let now = 0;
    const resumer = new SessionResumer(session, { resuming: () => undefined, now: () => now }, 1_000);
    resumer.start(new Error("dropped"));
    await settle();
    expect(calls.resumes).toBe(1);
    // The phone sat in the background for 5 s, five budgets, then came back: the dial it makes then is no last one.
    now = 5_000;
    resumer.now();
    await settle();
    expect(calls).toMatchObject({ resumes: 2, abandoned: [] });
    resumer.now();
    await settle();
    expect(calls).toMatchObject({ resumes: 3, abandoned: [] });
    expect(resumer.active).toBe(false);
  });

  test("a hidden page keeps dialing past the budget and never gives the session up; the wake then carries it on (#2853 review)", async () => {
    jest.useFakeTimers();
    const away = fakeSession(["refused"]);
    let now = 0;
    let hidden = true;
    const resumer = new SessionResumer(
      away.session,
      { resuming: () => undefined, now: () => now, hidden: () => hidden },
      60_000,
    );
    resumer.start(new Error("dropped"));
    await turns();
    // A background page that keeps running: every backoff fires and every dial fails, for 100 s, past the 60 s budget.
    for (let step = 0; step < 20; step += 1) {
      now += 5_000;
      jest.advanceTimersByTime(5_000);
      // oxlint-disable-next-line no-await-in-loop -- each backoff's dial runs before the next one is due
      await turns();
    }
    expect(away.calls.resumes).toBeGreaterThan(10);
    expect(away.calls.abandoned).toEqual([]);
    expect(resumer.active).toBe(true);
    // The person comes back and the host still holds the session.
    away.hostBack();
    hidden = false;
    resumer.now();
    await turns();
    expect(away.calls.abandoned).toEqual([]);
    expect(resumer.active).toBe(false);
  });

  test("a visible page still gives the session up once its budget runs out with every backoff waited (#2853 review)", async () => {
    jest.useFakeTimers();
    const down = fakeSession(["refused"]);
    let now = 0;
    const resumer = new SessionResumer(
      down.session,
      { resuming: () => undefined, now: () => now, hidden: () => false },
      60_000,
    );
    resumer.start(new Error("dropped"));
    await turns();
    for (let step = 0; step < 13 && down.calls.abandoned.length === 0; step += 1) {
      now += 5_000;
      jest.advanceTimersByTime(5_000);
      // oxlint-disable-next-line no-await-in-loop -- each backoff's dial runs before the next one is due
      await turns();
    }
    expect(down.calls.abandoned.map((error) => error.message)).toEqual(["could not resume the session: refused"]);
    expect(now).toBe(60_000);
    expect(resumer.active).toBe(false);
  });

  test("a link back from a 0.8 s blip is carried on well before the notice's 1.5 s gate (#2853)", async () => {
    jest.useFakeTimers();
    let now = 0;
    const blip = fakeSession(["refused"]);
    const resumed: number[] = [];
    const resumer = new SessionResumer(blip.session, {
      resuming: (on) => (on ? undefined : resumed.push(now)),
      now: () => now,
      hidden: () => false,
    });
    resumer.start(new Error("dropped"));
    await turns();
    for (let step = 0; step < 6 && resumed.length === 0; step += 1) {
      now += 250;
      // The link is back from 800 ms on: every dial from then on is answered.
      if (now >= 800) blip.hostBack();
      jest.advanceTimersByTime(250);
      // oxlint-disable-next-line no-await-in-loop -- each backoff's dial runs before the next one is due
      await turns();
    }
    expect(resumed).toEqual([1_000]);
    expect(blip.calls.abandoned).toEqual([]);
  });

  test("a link back after a 5.5 s outage is found within 3 s: no wait between dials is longer than that (#2928)", async () => {
    jest.useFakeTimers();
    let now = 0;
    const outage = fakeSession(["refused"]);
    const resumed: number[] = [];
    const resumer = new SessionResumer(outage.session, {
      resuming: (on) => (on ? undefined : resumed.push(now)),
      now: () => now,
      hidden: () => false,
    });
    resumer.start(new Error("dropped"));
    await turns();
    for (let step = 0; step < 60 && resumed.length === 0; step += 1) {
      now += 250;
      if (now >= 5_500) outage.hostBack();
      jest.advanceTimersByTime(250);
      // oxlint-disable-next-line no-await-in-loop -- each backoff's dial runs before the next one is due
      await turns();
    }
    expect(resumed.length).toBe(1);
    expect((resumed[0] ?? Infinity) - 5_500).toBeLessThanOrEqual(3_000);
    expect(Math.max(...RESUME_BACKOFF_MS)).toBe(3_000);
  });

  test("the page's dial budget holds every connection's resume to 30 dials in any minute (#2928 review)", async () => {
    jest.useFakeTimers();
    let now = 0;
    const budget = new DialBudget(30, () => now);
    const sessions = [fakeSession(["refused"]), fakeSession(["refused"]), fakeSession(["refused"])];
    const resumers = sessions.map(
      ({ session }) =>
        new SessionResumer(session, { resuming: () => undefined, now: () => now, hidden: () => true, budget }),
    );
    try {
      for (const resumer of resumers) resumer.start(new Error("dropped"));
      await turns();
      // The network is gone for all three machines: their ladders for just under a minute (at 60 s the first dials leave
      // the window, and the budget lets as many go again), a quarter second at a time.
      for (let step = 0; step < 239; step += 1) {
        now += 250;
        jest.advanceTimersByTime(250);
        // oxlint-disable-next-line no-await-in-loop -- each backoff's dial runs before the next one is due
        await turns();
      }
      const dials = sessions.reduce((sum, { calls }) => sum + calls.redials, 0);
      expect(dials).toBe(30);
      // Each one still dials: the budget is shared, not taken by the first.
      expect(sessions.every(({ calls }) => calls.redials > 0)).toBe(true);
    } finally {
      for (const resumer of resumers) resumer.stop();
    }
  });

  test("one connection's ladder never waits on the budget: about 24 dials in its first minute (#2928 review)", async () => {
    jest.useFakeTimers();
    let now = 0;
    const budget = new DialBudget(30, () => now);
    const { session, calls } = fakeSession(["refused"]);
    const resumer = new SessionResumer(session, {
      resuming: () => undefined,
      now: () => now,
      hidden: () => true,
      budget,
    });
    resumer.start(new Error("dropped"));
    await turns();
    for (let step = 0; step < 240; step += 1) {
      now += 250;
      jest.advanceTimersByTime(250);
      // oxlint-disable-next-line no-await-in-loop -- each backoff's dial runs before the next one is due
      await turns();
    }
    expect(calls.redials).toBeLessThan(30);
    expect(budget.waitMs()).toBe(0);
    resumer.stop();
  });
});
