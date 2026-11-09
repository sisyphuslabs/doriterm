import { describe, expect, test } from "bun:test";
import {
  MAX_REPLAY_BYTES,
  REPLAY_CAP_MS,
  ReplayMode,
  type ReplayEndReason,
  type ReplayTimer,
  replayQuietMs,
} from "./replay-mode.ts";

/** A clock and timers a test runs by hand: time moves only in `advance`, which then runs every timer that has come due. */
function manualTime() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { readonly at: number; readonly run: () => void }>();
  const timer: ReplayTimer = (run, ms) => {
    const id = next;
    next += 1;
    timers.set(id, { at: now + ms, run });
    return () => {
      timers.delete(id);
    };
  };
  const advance = (ms: number): void => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, each]) => each.at <= target)
        .toSorted(([, a], [, b]) => a.at - b.at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].run();
    }
    now = target;
  };
  return { now: () => now, timer, advance, pending: () => timers.size };
}

function replay(srtt: number | undefined) {
  const time = manualTime();
  const ended: ReplayEndReason[] = [];
  const mode = new ReplayMode({
    clock: time.now,
    timer: time.timer,
    srtt,
    onEnd: (reason) => void ended.push(reason),
  });
  return { time, ended, mode };
}

describe("the replay quiet window (#812)", () => {
  test("is max(100 ms, 1.5 * SRTT + 50 ms)", () => {
    expect([undefined, 0, 10, 100, 200, 500, 1000].map(replayQuietMs)).toEqual([100, 100, 100, 200, 350, 800, 1550]);
  });

  test("a measured round trip widens it, and an unanswered one leaves the floor", () => {
    expect(replayQuietMs(Number.NaN)).toBe(100);
    expect(replayQuietMs(240)).toBe(410);
  });
});

describe("ReplayMode's end rules (#812)", () => {
  test("quiet for the window since the last DATA frame ends it", () => {
    const { time, ended, mode } = replay(200);
    time.advance(40);
    mode.frame(16);
    time.advance(349);
    expect(ended).toEqual([]);
    time.advance(1);
    expect(ended).toEqual(["quiet"]);
  });

  test("every DATA frame starts the quiet window over", () => {
    const { time, ended, mode } = replay(100);
    mode.frame(16);
    time.advance(150);
    mode.frame(16);
    time.advance(150);
    expect(ended).toEqual([]);
    time.advance(50);
    expect(ended).toEqual(["quiet"]);
  });

  test("without a round-trip sample the quiet window is its 100 ms floor", () => {
    const { time, ended } = replay(undefined);
    time.advance(99);
    expect(ended).toEqual([]);
    time.advance(1);
    expect(ended).toEqual(["quiet"]);
  });

  test("the 1500 ms cap ends a replay that keeps receiving frames", () => {
    const { time, ended, mode } = replay(500);
    for (let at = 0; at < REPLAY_CAP_MS; at += 100) {
      mode.frame(16);
      time.advance(100);
    }
    expect(ended).toEqual(["cap"]);
    time.advance(10_000);
    expect(ended).toEqual(["cap"]);
  });

  test("a frame that reaches MAX_REPLAY_BYTES ends it as bytes, and later frames are ignored", () => {
    const { time, ended, mode } = replay(undefined);
    mode.frame(MAX_REPLAY_BYTES - 1);
    expect(ended).toEqual([]);
    mode.frame(1);
    expect(ended).toEqual(["bytes"]);
    time.advance(10_000);
    mode.frame(MAX_REPLAY_BYTES);
    expect(ended).toEqual(["bytes"]);
  });

  test("a synchronized update stands it down, and its timers are cancelled", () => {
    const { time, ended, mode } = replay(100);
    mode.frame(16);
    mode.standDown();
    expect(ended).toEqual(["synchronized"]);
    expect(time.pending()).toBe(0);
    time.advance(10_000);
    expect(ended).toEqual(["synchronized"]);
  });

  test("cancel forgets it without reporting an end", () => {
    const { time, ended, mode } = replay(100);
    mode.frame(16);
    mode.cancel();
    expect(time.pending()).toBe(0);
    time.advance(10_000);
    expect(ended).toEqual([]);
  });

  test("an ended mode reports once", () => {
    const { time, ended, mode } = replay(100);
    time.advance(REPLAY_CAP_MS + 1_000);
    expect(ended).toEqual(["quiet"]);
    mode.standDown();
    mode.frame(16);
    expect(ended).toEqual(["quiet"]);
  });
});
