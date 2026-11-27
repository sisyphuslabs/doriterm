import { afterEach, describe, expect, jest, test } from "bun:test";
import { RESUME_BACKOFF_MS, SessionResumer } from "./session-resume.ts";
import { fakeSession, settle, turns } from "./session-resume.test-support.ts";

afterEach(() => jest.useRealTimers());

describe("SessionResumer's ladder", () => {
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
});
