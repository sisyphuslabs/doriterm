import { expect, test } from "bun:test";
import { LATE_TIMER_MS, OutputPacer } from "./output-pacer.ts";
import { bytes, KIB, manualFrames, manualTimers, OPEN, text } from "./output-pacer.test-support.ts";

// A timer that runs late was held up by a page busy with other work (writing a 16 KiB batch on a page 6x slower takes a
// while), and so was any output that arrived meanwhile: it is queued behind the timer. Read as quiet, the timer would
// let a hold go with the next bytes already waiting, and what follows would be paced up the screen (#2895).

/** A pacer whose clock runs `late.ms` ahead of its timers once the test sets it: the page was busy that long. */
function stalling() {
  const frames = manualFrames();
  const timers = manualTimers();
  const late = { ms: 0 };
  const holds: string[] = [];
  const pacer = new OutputPacer(
    () => undefined,
    frames.frame,
    () => timers.now() + late.ms,
    timers.timer,
  );
  pacer.holdSynchronized((held) => holds.push(`update ${held ? "held" : "let go"}`));
  return { timers, late, holds, pacer };
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

test("a timer run no later than a page doing nothing else runs it is on time: the window is read", () => {
  const { timers, late, holds, pacer } = stalling();
  pacer.replay({ srtt: () => 100, hold: () => undefined });
  pacer.push(bytes(KIB));
  pacer.push(new Uint8Array([...text(OPEN), ...bytes(KIB)]));
  late.ms = LATE_TIMER_MS;
  timers.advance(1000);
  expect(holds).toEqual(["update held", "update let go"]);
});
