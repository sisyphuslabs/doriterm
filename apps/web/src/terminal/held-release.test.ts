import { expect, test } from "bun:test";
import { HeldRelease, type ReleaseClock, SYNCHRONIZED_HOLD_MS } from "./held-release.ts";

/** A clock whose frames and timers run only when the test says, and whose synchronized state the test sets. */
function fakeClock() {
  let now = 0;
  let synchronized = false;
  let frames: (() => void)[] = [];
  let timers: { at: number; run: () => void }[] = [];
  const clock: ReleaseClock = {
    now: () => now,
    frame: (run) => {
      frames.push(run);
      return () => void (frames = frames.filter((each) => each !== run));
    },
    timer: (run, ms) => {
      const entry = { at: now + ms, run };
      timers.push(entry);
      return () => void (timers = timers.filter((each) => each !== entry));
    },
    synchronized: () => synchronized,
  };
  return {
    clock,
    sync: (on: boolean) => void (synchronized = on),
    frame: (ms = 16) => {
      now += ms;
      const due = frames;
      frames = [];
      for (const run of due) run();
    },
    advance: (ms: number) => {
      now += ms;
      const due = timers.filter((each) => each.at <= now);
      timers = timers.filter((each) => each.at > now);
      for (const each of due) each.run();
    },
  };
}

function released(clock: ReleaseClock) {
  let count = 0;
  const hold = new HeldRelease(clock, () => (count += 1));
  return { hold, count: () => count };
}

test("outside a synchronized update a held cell goes on the next frame", () => {
  const fake = fakeClock();
  const { hold, count } = released(fake.clock);
  hold.hold();
  expect(count()).toBe(0);
  fake.frame();
  expect(count()).toBe(1);
});

test("inside a synchronized update a frame does not release it: only the grid changing does", () => {
  const fake = fakeClock();
  const { hold, count } = released(fake.clock);
  fake.sync(true);
  hold.hold();
  for (let frame = 0; frame < 30; frame += 1) fake.frame();
  fake.advance(400);
  expect(count()).toBe(0);
  hold.rendered();
  expect(count()).toBe(1);
  fake.advance(SYNCHRONIZED_HOLD_MS);
  expect(count()).toBe(1);
});

test("an update opened after the hold began, before its frame, is waited for too", () => {
  const fake = fakeClock();
  const { hold, count } = released(fake.clock);
  hold.hold();
  fake.sync(true);
  fake.frame();
  expect(count()).toBe(0);
  hold.rendered();
  expect(count()).toBe(1);
});

test("the wait is capped at SYNCHRONIZED_HOLD_MS from when the hold began, with no grid change at all", () => {
  expect(SYNCHRONIZED_HOLD_MS).toBe(1000);
  const fake = fakeClock();
  const { hold, count } = released(fake.clock);
  hold.hold();
  fake.sync(true);
  fake.frame(16);
  fake.advance(SYNCHRONIZED_HOLD_MS - 17);
  expect(count()).toBe(0);
  fake.advance(1);
  expect(count()).toBe(1);
});

test("a second hold while one is armed keeps the first deadline", () => {
  const fake = fakeClock();
  const { hold, count } = released(fake.clock);
  fake.sync(true);
  hold.hold();
  fake.advance(600);
  hold.hold();
  fake.advance(400);
  expect(count()).toBe(1);
});
