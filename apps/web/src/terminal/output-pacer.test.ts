import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { FRAME_BYTES, type FrameTimer, OutputPacer, SYNCHRONIZED_UNPACED_MS } from "./output-pacer.ts";
import { type ReplayEndReason, type ReplayTimer, replayQuietMs } from "./replay-mode.ts";

/** Animation frames that run only when the test says so. */
function manualFrames() {
  const frames: (() => void)[] = [];
  const frame: FrameTimer = (run) => {
    frames.push(run);
    return () => frames.splice(frames.indexOf(run), 1);
  };
  return { frame, frames, nextFrame: (): void => frames.shift()?.() };
}

const bytes = (length: number, fill = 0x61) => new Uint8Array(length).fill(fill);

describe("OutputPacer.busy", () => {
  test("it reports queued output until a frame writes it", () => {
    const frames = manualFrames();
    const written: number[] = [];
    const pacer = new OutputPacer(
      (frame) => written.push(frame.byteLength),
      frames.frame,
      () => 0,
    );
    expect(pacer.busy).toBe(false);
    pacer.push(bytes(4));
    expect(pacer.busy).toBe(true);
    frames.nextFrame();
    expect(pacer.busy).toBe(false);
    expect(written).toEqual([4]);
  });
});

describe("OutputPacer (#560)", () => {
  test("output that arrives within a frame is written once, on the frame, and credited only then", () => {
    const clock = manualFrames();
    const written: number[] = [];
    const credited: number[] = [];
    const pacer = new OutputPacer((batch) => written.push(batch.byteLength), clock.frame);
    for (const size of [10, 20, 30]) pacer.push(bytes(size), (count) => credited.push(count));
    expect(written).toEqual([]);
    expect(credited).toEqual([]);
    clock.nextFrame();
    expect(written).toEqual([60]);
    expect(credited).toEqual([10, 20, 30]);
  });

  test("a flood is written at most FRAME_BYTES a frame, in order, with credit for exactly what was written", () => {
    const clock = manualFrames();
    const written: Uint8Array[] = [];
    let credited = 0;
    const pacer = new OutputPacer((batch) => written.push(batch), clock.frame);
    pacer.push(bytes(FRAME_BYTES + 100, 0x61), (count) => (credited += count));
    pacer.push(bytes(50, 0x62), (count) => (credited += count));
    clock.nextFrame();
    expect(written.map((batch) => batch.byteLength)).toEqual([FRAME_BYTES]);
    expect(credited).toBe(FRAME_BYTES);
    clock.nextFrame();
    expect(written.map((batch) => batch.byteLength)).toEqual([FRAME_BYTES, 150]);
    expect(credited).toBe(FRAME_BYTES + 150);
    expect([...(written[1] ?? [])]).toEqual([...bytes(100, 0x61), ...bytes(50, 0x62)]);
    expect(clock.frames).toHaveLength(0);
  });

  test("out of view nothing is written or credited; once it shows, what waited is written from the next frame", () => {
    const clock = manualFrames();
    const written: number[] = [];
    let credited = 0;
    const pacer = new OutputPacer((batch) => written.push(batch.byteLength), clock.frame);
    pacer.setVisible(false);
    pacer.push(bytes(5), (count) => (credited += count));
    pacer.push(bytes(7), (count) => (credited += count));
    expect(clock.frames).toHaveLength(0);
    expect(written).toEqual([]);
    expect(credited).toBe(0);
    pacer.setVisible(true);
    clock.nextFrame();
    expect(written).toEqual([12]);
    expect(credited).toBe(12);
  });

  test("drop forgets queued output without crediting it", () => {
    const clock = manualFrames();
    const written: number[] = [];
    let credited = 0;
    const pacer = new OutputPacer((batch) => written.push(batch.byteLength), clock.frame);
    pacer.push(bytes(9), (count) => (credited += count));
    pacer.drop();
    expect(clock.frames).toHaveLength(0);
    pacer.push(bytes(4));
    clock.nextFrame();
    expect(written).toEqual([4]);
    expect(credited).toBe(0);
  });
});

const text = (value: string) => new TextEncoder().encode(value);
const OPEN = "\u001b[?2026h";
const CLOSE = "\u001b[?2026l";

describe("OutputPacer in a synchronized update (#757)", () => {
  test("an update is written as it arrives, uncapped, with its credit, and output after it is paced again", () => {
    const clock = manualFrames();
    const written: number[] = [];
    let credited = 0;
    const pacer = new OutputPacer(
      (batch) => written.push(batch.byteLength),
      clock.frame,
      () => 0,
    );
    const credit = (count: number): void => void (credited += count);
    pacer.push(text(OPEN), credit);
    clock.nextFrame();
    expect(written).toEqual([OPEN.length]);
    // A whole transcript, far over a frame's bytes, arrives in pieces while the update is open: each is written at once.
    pacer.push(bytes(FRAME_BYTES * 3), credit);
    pacer.push(bytes(FRAME_BYTES * 2), credit);
    expect(written).toEqual([OPEN.length, FRAME_BYTES * 3, FRAME_BYTES * 2]);
    expect(credited).toBe(OPEN.length + FRAME_BYTES * 5);
    expect(clock.frames).toHaveLength(0);
    // The update ends inside a piece: up to its end at once, the rest a frame's bytes at a time.
    const ending = new Uint8Array([...text(CLOSE), ...bytes(FRAME_BYTES * 2)]);
    pacer.push(ending, credit);
    expect(written.slice(3)).toEqual([CLOSE.length]);
    clock.nextFrame();
    expect(written.slice(4)).toEqual([FRAME_BYTES]);
    clock.nextFrame();
    expect(written.slice(5)).toEqual([FRAME_BYTES]);
    expect(credited).toBe(OPEN.length + FRAME_BYTES * 5 + ending.byteLength);
  });

  test("an update opened in a frame's batch has the rest of the queue written in that frame", () => {
    const clock = manualFrames();
    const written: number[] = [];
    const pacer = new OutputPacer(
      (batch) => written.push(batch.byteLength),
      clock.frame,
      () => 0,
    );
    pacer.push(new Uint8Array([...text(OPEN), ...bytes(FRAME_BYTES * 4)]));
    pacer.push(text(CLOSE));
    pacer.push(bytes(FRAME_BYTES + 1));
    clock.nextFrame();
    expect(written).toEqual([OPEN.length + FRAME_BYTES * 4 + CLOSE.length]);
    clock.nextFrame();
    expect(written.slice(1)).toEqual([FRAME_BYTES]);
  });

  test("an update held open past the terminal's own hold is paced again", () => {
    const clock = manualFrames();
    let now = 0;
    const written: number[] = [];
    const pacer = new OutputPacer(
      (batch) => written.push(batch.byteLength),
      clock.frame,
      () => now,
    );
    pacer.push(text(OPEN));
    clock.nextFrame();
    pacer.push(bytes(FRAME_BYTES * 2));
    expect(written).toEqual([OPEN.length, FRAME_BYTES * 2]);
    now = SYNCHRONIZED_UNPACED_MS;
    pacer.push(bytes(FRAME_BYTES * 2));
    expect(written).toHaveLength(2);
    clock.nextFrame();
    expect(written.slice(2)).toEqual([FRAME_BYTES]);
  });

  test("out of view an update waits like any output, and drop forgets that one was open", () => {
    const clock = manualFrames();
    const written: number[] = [];
    const pacer = new OutputPacer(
      (batch) => written.push(batch.byteLength),
      clock.frame,
      () => 0,
    );
    pacer.push(text(OPEN));
    clock.nextFrame();
    pacer.setVisible(false);
    pacer.push(bytes(10));
    expect(written).toEqual([OPEN.length]);
    pacer.setVisible(true);
    clock.nextFrame();
    expect(written.slice(1)).toEqual([10]);
    pacer.drop();
    pacer.push(bytes(FRAME_BYTES * 2));
    expect(written).toHaveLength(2);
    clock.nextFrame();
    expect(written.slice(2)).toEqual([FRAME_BYTES]);
  });
});

/** Frames, a clock and timers a test runs by hand: nothing here happens until the test says so. */
function manualTime() {
  let now = 0;
  let next = 1;
  const frames: (() => void)[] = [];
  const timers = new Map<number, { readonly at: number; readonly run: () => void }>();
  const frame: FrameTimer = (run) => {
    frames.push(run);
    return () => {
      frames.splice(frames.indexOf(run), 1);
    };
  };
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
  return {
    frame,
    timer,
    advance,
    now: () => now,
    frames,
    nextFrame: (): void => frames.shift()?.(),
  };
}

describe("OutputPacer in a replay (#812)", () => {
  test("a replay writes its first paint as it arrives, uncapped, and holds until its quiet window ends", () => {
    const time = manualTime();
    const written: number[] = [];
    let credited = 0;
    const pacer = new OutputPacer((batch) => written.push(batch.byteLength), time.frame, time.now, time.timer);
    const changes: boolean[] = [];
    pacer.onReplayChange(() => changes.push(pacer.replaying));
    expect(pacer.replaying).toBe(false);
    pacer.beginReplay({ srtt: 100 });
    expect(pacer.replaying).toBe(true);
    pacer.push(bytes(FRAME_BYTES * 3), (count) => (credited += count));
    pacer.push(bytes(FRAME_BYTES * 2), (count) => (credited += count));
    expect(written).toEqual([FRAME_BYTES * 3, FRAME_BYTES * 2]);
    expect(credited).toBe(FRAME_BYTES * 5);
    expect(time.frames).toHaveLength(0);
    time.advance(replayQuietMs(100));
    expect(pacer.replaying).toBe(false);
    expect(changes).toEqual([true, false]);
    // Once the replay ends, output is paced again: a frame's bytes a frame.
    pacer.push(bytes(FRAME_BYTES + 1));
    expect(written).toHaveLength(2);
    time.nextFrame();
    expect(written.slice(2)).toEqual([FRAME_BYTES]);
  });

  test("a replay's paint is released before its end is reported, so the end-hold runs on the shown replay", () => {
    const time = manualTime();
    const order: string[] = [];
    const pacer = new OutputPacer(() => undefined, time.frame, time.now, time.timer);
    pacer.onReplayChange(() => order.push(`replaying:${pacer.replaying}`));
    pacer.beginReplay({ srtt: 100, onEnd: () => order.push(`ended:${pacer.replaying}`) });
    time.advance(replayQuietMs(100));
    expect(order).toEqual(["replaying:true", "replaying:false", "ended:false"]);
  });

  test("a synchronized bracket stands the replay down: the update's own hold paints it, not a second one", () => {
    const time = manualTime();
    const written: number[] = [];
    const reasons: ReplayEndReason[] = [];
    const pacer = new OutputPacer((batch) => written.push(batch.byteLength), time.frame, time.now, time.timer);
    const changes: boolean[] = [];
    pacer.onReplayChange(() => changes.push(pacer.replaying));
    pacer.beginReplay({ srtt: 100, onEnd: (reason) => void reasons.push(reason) });
    pacer.push(new Uint8Array([...text(OPEN), ...bytes(100)]));
    expect(pacer.replaying).toBe(false);
    expect(reasons).toEqual(["synchronized"]);
    expect(changes).toEqual([true, false]);
    expect(written).toEqual([OPEN.length + 100]);
    // The open update keeps writing unpaced, as the pacer already did for one.
    pacer.push(bytes(FRAME_BYTES * 2));
    expect(written).toEqual([OPEN.length + 100, FRAME_BYTES * 2]);
    time.advance(10_000);
    expect(reasons).toEqual(["synchronized"]);
  });

  test("the cap ends a replay while output keeps arriving", () => {
    const time = manualTime();
    const written: number[] = [];
    const reasons: ReplayEndReason[] = [];
    const pacer = new OutputPacer((batch) => written.push(batch.byteLength), time.frame, time.now, time.timer);
    pacer.beginReplay({ srtt: 500, onEnd: (reason) => void reasons.push(reason) });
    for (let at = 0; at < 1_500; at += 100) {
      pacer.push(bytes(16));
      time.advance(100);
    }
    expect(pacer.replaying).toBe(false);
    expect(reasons).toEqual(["cap"]);
    pacer.push(bytes(FRAME_BYTES + 1));
    expect(written).toHaveLength(15);
    time.nextFrame();
    expect(written.at(-1)).toBe(FRAME_BYTES);
  });

  test("drop forgets a replay without ending it", () => {
    const time = manualTime();
    const written: number[] = [];
    const reasons: ReplayEndReason[] = [];
    const pacer = new OutputPacer((batch) => written.push(batch.byteLength), time.frame, time.now, time.timer);
    pacer.beginReplay({ srtt: 100, onEnd: (reason) => void reasons.push(reason) });
    pacer.push(bytes(40));
    pacer.drop();
    expect(pacer.replaying).toBe(false);
    expect(reasons).toEqual([]);
    pacer.push(bytes(FRAME_BYTES * 2));
    expect(written).toEqual([40]);
    time.nextFrame();
    expect(written).toEqual([40, FRAME_BYTES]);
  });
});

test("the unpaced window is the synchronized-output hold of the @wterm/dom that is installed (#1020)", async () => {
  const bundle = join(dirname(Bun.resolveSync("@wterm/dom", import.meta.dir)), "wterm.js");
  const hold = /\bSYNCHRONIZED_OUTPUT_TIMEOUT_MS = (\d+);/.exec(await Bun.file(bundle).text())?.[1];
  expect(hold).toBeDefined();
  expect(Number(hold)).toBe(SYNCHRONIZED_UNPACED_MS);
});
