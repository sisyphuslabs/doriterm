import { describe, expect, test } from "bun:test";
import { stopWriter } from "./host-writers.ts";
import { HC_STOP_GRACE_MS } from "./mesh/hc-machines.ts";

/** Timers that fire only when the test moves time on. */
function virtualClock() {
  let now = 0;
  const timers = new Set<{ readonly at: number; readonly run: () => void }>();
  return {
    after(ms: number, run: () => void) {
      const timer = { at: now + ms, run };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    advance(ms: number) {
      now += ms;
      for (const timer of timers) {
        if (timer.at > now) continue;
        timers.delete(timer);
        timer.run();
      }
    },
    pending: () => timers.size,
  };
}

/** A writer whose child ignores a closed stdin: its stop settles only once it is killed (#441). */
function heldWriter() {
  const exited = Promise.withResolvers<void>();
  const kills: number[] = [];
  return {
    stop: () => exited.promise,
    kill() {
      kills.push(4242);
      exited.resolve();
      return [4242];
    },
    kills,
  };
}

describe("stopWriter (#441)", () => {
  test("a child that does not exit on close is killed once the grace has passed, and not before", async () => {
    const clock = virtualClock();
    const writer = heldWriter();
    let stopped = false;
    const stopping = (async () => {
      await stopWriter(writer, clock);
      stopped = true;
    })();
    clock.advance(HC_STOP_GRACE_MS - 1);
    await Promise.resolve();
    expect([writer.kills, stopped]).toEqual([[], false]);
    clock.advance(1);
    await stopping;
    expect([writer.kills, stopped, clock.pending()]).toEqual([[4242], true, 0]);
  });

  test("a child that exits on close is never killed, and its grace is cancelled", async () => {
    const clock = virtualClock();
    let killed = false;
    await stopWriter(
      {
        stop: () => Promise.resolve(),
        kill: () => {
          killed = true;
          return [];
        },
      },
      clock,
    );
    expect([killed, clock.pending()]).toEqual([false, 0]);
  });
});
