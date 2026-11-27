import { expect, test } from "bun:test";
import { LATE_TIMER_MS, OutputPacer, SYNCHRONIZED_HOLD_CAP_MS, SYNCHRONIZED_UNPACED_MS } from "./output-pacer.ts";
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
  // The page was busy for 600 ms past the window's 1000 ms; the next window of the update was queued behind the timer,
  // posted before it ran (a task registered now, due with it, runs after it).
  late.ms = 600;
  timers.timer(() => pacer.push(bytes(16 * KIB)), 1000);
  timers.advance(1000);
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
  // 1.5 x 300 + 50 = 500 ms, run 300 ms late, with the next window queued behind it.
  late.ms = 300;
  timers.timer(() => pacer.push(bytes(256 * KIB)), 500);
  timers.advance(500);
  expect(replay).toEqual([true]);
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

test("on a page whose every timer runs late and no bytes come, a replay is let go at its first quiet window", () => {
  const { timers, late, pacer, clock } = stalling();
  const replay: boolean[] = [];
  pacer.replay({ srtt: () => 300, hold: (held) => replay.push(held) });
  pacer.push(bytes(256 * KIB));
  const lastBytes = clock();
  // Every timer runs 600 ms late, and nothing is queued behind any of them.
  late.each = 600;
  const at = releaseTime(timers, clock, () => replay.length > 1);
  expect(replay).toEqual([true, false]);
  // The 500 ms window read 600 ms late, and its reading, one task later, 600 ms late too on this page; then one step of
  // the test's 100 ms clock at most.
  expect(at - lastBytes).toBeLessThanOrEqual(500 + 2 * 600 + 100);
});

// A drag on a loaded machine: each step's relayout keeps the page busy past every timer, and the program sends nothing.
// The held update is let go at its first quiet window, not after the hold's cap: the screen does not freeze (#2941).
test("a held update is let go a quiet window after its last bytes while a drag makes every timer late and no bytes come", () => {
  const { timers, late, holds, pacer, clock } = stalling();
  pacer.replay({ srtt: () => 100, hold: () => undefined });
  pacer.push(bytes(KIB));
  pacer.push(new Uint8Array([...text(OPEN), ...bytes(KIB)]));
  const lastBytes = clock();
  late.each = 600;
  let at = Number.POSITIVE_INFINITY;
  for (let step = 0; step < 40 && at === Number.POSITIVE_INFINITY; step += 1) {
    pacer.resized(80);
    timers.advance(100);
    if (holds.length > 1) at = clock();
  }
  expect(holds).toEqual(["update held", "update let go"]);
  // The window read late, and its reading one task later, late too on this page.
  expect(at - lastBytes).toBeLessThanOrEqual(SYNCHRONIZED_UNPACED_MS + 2 * 600 + 100);
  expect(at - lastBytes).toBeLessThan(SYNCHRONIZED_HOLD_CAP_MS);
});

// The same drag on a Mac: the shell answers each resize by redrawing its prompt, queued behind each late timer. The hold
// ignores those answers on time (#2922), and a late timer's reading must ignore them too, or it holds to the cap (#2941).
test("a held update is let go a quiet window after its last bytes while a loaded drag brings a prompt redraw per resize", () => {
  const { timers, late, holds, pacer, clock } = stalling();
  pacer.replay({ srtt: () => 100, hold: () => undefined });
  pacer.push(bytes(KIB));
  pacer.push(new Uint8Array([...text(OPEN), ...bytes(KIB)]));
  const lastBytes = clock();
  late.each = 600;
  const prompt = text(`\r${" ".repeat(60)}\rbash-3.2$ `);
  // A resize and its answer every 10 ms for 4 s, each posted before any timer due with it runs: a late quiet timer
  // finds an answer queued behind it, as a page does whose drag outpaces its timers.
  for (let ms = 10; ms <= 4000; ms += 10)
    timers.timer(() => {
      pacer.resized(80);
      pacer.push(prompt);
    }, ms);
  const at = releaseTime(timers, clock, () => holds.length > 1);
  expect(holds).toEqual(["update held", "update let go"]);
  expect(at - lastBytes).toBeLessThanOrEqual(SYNCHRONIZED_UNPACED_MS + 2 * 600 + 100);
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
