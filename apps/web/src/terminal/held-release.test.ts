import { expect, test } from "bun:test";
import { HeldRelease, type ReleaseClock, SYNCHRONIZED_HOLD_MARGIN_MS, SYNCHRONIZED_HOLD_MS } from "./held-release.ts";

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

test("the wait is capped past wterm's hold from when the update was first seen, with no grid change at all", () => {
  expect(SYNCHRONIZED_HOLD_MS).toBe(1000);
  const fake = fakeClock();
  const { hold, count } = released(fake.clock);
  hold.hold();
  fake.sync(true);
  fake.frame(16);
  fake.advance(SYNCHRONIZED_HOLD_MS + SYNCHRONIZED_HOLD_MARGIN_MS - 1);
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
  fake.advance(400 + SYNCHRONIZED_HOLD_MARGIN_MS);
  expect(count()).toBe(1);
});

test("an update opened after the hold began is held until the renderer's own fallback has painted (#2083)", () => {
  const fake = fakeClock();
  const { hold, count } = released(fake.clock);
  hold.hold();
  // The write that opens the update lands at 10 ms and starts wterm's own SYNCHRONIZED_HOLD_MS there; the hold sees the
  // update open at its frame, at 16 ms.
  fake.advance(10);
  fake.sync(true);
  const fallback = 10 + SYNCHRONIZED_HOLD_MS;
  fake.frame(6);
  fake.advance(fallback - 16 - 1);
  expect(count()).toBe(0);
  // The fallback paints: the grid changes, and the cell goes in the same frame as the echo appears.
  fake.advance(1);
  hold.rendered();
  expect(count()).toBe(1);
});

test("a hold made inside the write that opens the update outlasts the fallback that write starts (#2083)", () => {
  const fake = fakeClock();
  const { hold, count } = released(fake.clock);
  // A reply sent during the write reaches the hold with the update already open, before wterm arms its timer.
  fake.sync(true);
  hold.hold();
  fake.advance(SYNCHRONIZED_HOLD_MS);
  expect(count()).toBe(0);
  hold.rendered();
  expect(count()).toBe(1);
});

test("on a starved frame the cap counts from when the update was seen open, not from the hold (#2083)", () => {
  const fake = fakeClock();
  const { hold, count } = released(fake.clock);
  hold.hold();
  // The next frame comes 300 ms late; the write that opened the update landed at 290 ms and started wterm's fallback.
  fake.advance(290);
  fake.sync(true);
  fake.frame(10);
  fake.advance(SYNCHRONIZED_HOLD_MS - 10 - 1);
  expect(count()).toBe(0);
  fake.advance(1);
  hold.rendered();
  expect(count()).toBe(1);
});
