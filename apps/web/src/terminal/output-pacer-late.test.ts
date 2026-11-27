import { expect, test } from "bun:test";
import { LATE_TIMER_MS, OutputPacer, SYNCHRONIZED_HOLD_CAP_MS } from "./output-pacer.ts";
import { bytes, KIB, manualFrames, manualTimers, OPEN, text } from "./output-pacer.test-support.ts";

// A timer that runs late was held up by a page busy with other work (writing a 16 KiB batch on a page 6x slower takes a
// while), and so was any output that arrived meanwhile: it is queued behind the timer. Read as quiet, the timer would
// let a hold go with the next bytes already waiting, and what follows would be paced up the screen (#2895).

/**
 * A pacer whose clock runs `late.ms` ahead of its timers once the test sets it (the page was busy that long, once), and
 * `late.each` more ahead before every timer it runs (a page that stays busy: every timer runs that late).
 */
function stalling() {
  const frames = manualFrames();
  const timers = manualTimers();
  const late = { ms: 0, each: 0 };
  let busy = 0;
  const holds: string[] = [];
  const pacer = new OutputPacer(
    () => undefined,
    frames.frame,
    () => timers.now() + late.ms + busy,
    (run, ms) =>
      timers.timer(() => {
        busy += late.each;
        run();
      }, ms),
  );
  pacer.holdSynchronized((held) => holds.push(`update ${held ? "held" : "let go"}`));
  const clock = (): number => timers.now() + late.ms + busy;
  return { timers, late, holds, pacer, clock };
}

test("a program's held update is not let go by a quiet window whose timer ran late, even less late than its length", () => {
  const { timers, late, holds, pacer } = stalling();
  pacer.replay({ srtt: () => 100, hold: () => undefined });
  pacer.push(bytes(KIB));
  pacer.push(new Uint8Array([...text(OPEN), ...bytes(16 * KIB)]));
  expect(holds).toEqual(["update held"]);
  // The page was busy for 600 ms past the window's 1000 ms; the next window was queued behind it.
  late.ms = 600;
  timers.advance(1000);
  expect(holds).toEqual(["update held"]);
  pacer.push(bytes(16 * KIB));
  expect(holds).toEqual(["update held"]);
  // Quiet for a whole window on time, the update is let go as before (#853).
  timers.advance(1000);
  expect(holds).toEqual(["update held", "update let go"]);
});

test("a replay's quiet window whose timer ran late, by less than its length, does not end the replay", () => {
  const { timers, late, pacer } = stalling();
  const replay: boolean[] = [];
  pacer.replay({ srtt: () => 300, hold: (held) => replay.push(held) });
  pacer.push(bytes(256 * KIB));
  // 1.5 x 300 + 50 = 500 ms, run 300 ms late.
  late.ms = 300;
  timers.advance(500);
  expect(replay).toEqual([true]);
  pacer.push(bytes(256 * KIB));
  timers.advance(499);
  expect(replay).toEqual([true]);
  timers.advance(1);
  expect(replay).toEqual([true, false]);
});

/** Advances in 100 ms steps until `released()`; returns the page's clock then, or Infinity if it never was. */
function releaseTime(timers: { advance: (ms: number) => void }, clock: () => number, released: () => boolean): number {
  for (let step = 0; step < 400; step += 1) {
    timers.advance(100);
    if (released()) return clock();
  }
  return Number.POSITIVE_INFINITY;
}

test("on a page whose every timer runs late, a replay is still let go once no bytes have come for the hold's cap", () => {
  const { timers, late, pacer, clock } = stalling();
  const replay: boolean[] = [];
  pacer.replay({ srtt: () => 300, hold: (held) => replay.push(held) });
  pacer.push(bytes(256 * KIB));
  const lastBytes = clock();
  // Every timer runs 600 ms late: every window restarts, and none would be read as quiet on its own.
  late.each = 600;
  const at = releaseTime(timers, clock, () => replay.length > 1);
  expect(replay).toEqual([true, false]);
  // Let go at the cap after the last bytes, by the page's own clock, however late each timer ran.
  expect(at - lastBytes).toBeGreaterThanOrEqual(SYNCHRONIZED_HOLD_CAP_MS);
  expect(at - lastBytes).toBeLessThan(SYNCHRONIZED_HOLD_CAP_MS + 2000);
});

test("on a page whose every timer runs late, a program's held update is let go once no bytes have come for the cap", () => {
  const { timers, late, holds, pacer, clock } = stalling();
  pacer.replay({ srtt: () => 100, hold: () => undefined });
  pacer.push(bytes(KIB));
  pacer.push(new Uint8Array([...text(OPEN), ...bytes(KIB)]));
  const lastBytes = clock();
  late.each = 600;
  const at = releaseTime(timers, clock, () => holds.length > 1);
  expect(holds).toEqual(["update held", "update let go"]);
  expect(at - lastBytes).toBeLessThan(SYNCHRONIZED_HOLD_CAP_MS + 2000);
});

test("a timer run no later than a page doing nothing else runs it is on time: the window is read", () => {
  const { timers, late, holds, pacer } = stalling();
  pacer.replay({ srtt: () => 100, hold: () => undefined });
  pacer.push(bytes(KIB));
  pacer.push(new Uint8Array([...text(OPEN), ...bytes(KIB)]));
  late.ms = LATE_TIMER_MS;
  timers.advance(1000);
  expect(holds).toEqual(["update held", "update let go"]);
});
