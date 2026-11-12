import { expect, test } from "bun:test";
import type { Schedule } from "./feed.ts";
import { Reread } from "./reread.ts";

/** A schedule the test fires by hand: each entry is a pending run with its delay, until fired or cancelled. */
function heldTimers() {
  const pending: { readonly run: () => void; readonly inMs: number; cancelled: boolean }[] = [];
  const schedule: Schedule = (run, inMs) => {
    const entry = { run, inMs, cancelled: false };
    pending.push(entry);
    return () => void (entry.cancelled = true);
  };
  const fire = (): void => {
    const next = pending.find((entry) => !entry.cancelled);
    if (next === undefined) throw new Error("nothing is scheduled");
    next.cancelled = true;
    next.run();
  };
  return { pending, schedule, fire };
}

test("each failed read waits twice as long as the one before, to a cap, and a read that lands starts over", () => {
  const timers = heldTimers();
  let reads = 0;
  const reread = new Reread(
    () => (reads += 1),
    () => true,
    timers.schedule,
  );

  for (let failure = 0; failure < 6; failure += 1) {
    reread.failed();
    timers.fire();
  }
  expect(timers.pending.map((entry) => entry.inMs)).toEqual([500, 1_000, 2_000, 4_000, 8_000, 8_000]);
  expect(reads).toBe(6);

  reread.landed();
  reread.failed();
  expect(timers.pending.at(-1)?.inMs).toBe(500);
});

test("a read that lands, or a document no longer wanted, cancels the read still waiting", () => {
  const timers = heldTimers();
  let reads = 0;
  const reread = new Reread(
    () => (reads += 1),
    () => true,
    timers.schedule,
  );

  reread.failed();
  reread.landed();
  reread.failed();
  reread.stop();
  expect(timers.pending.every((entry) => entry.cancelled)).toBe(true);
  expect(reads).toBe(0);
});

test("a read due while the roster is not reading (no surface, or a closed link) is skipped and not scheduled again", () => {
  const timers = heldTimers();
  let reads = 0;
  let reading = false;
  const reread = new Reread(
    () => (reads += 1),
    () => reading,
    timers.schedule,
  );

  reread.failed();
  timers.fire();
  expect(reads).toBe(0);
  expect(timers.pending.filter((entry) => !entry.cancelled)).toHaveLength(0);

  reading = true;
  reread.failed();
  timers.fire();
  expect(reads).toBe(1);
});
