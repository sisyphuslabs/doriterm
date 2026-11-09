import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { FRAME_BYTES, type FrameTimer, OutputPacer, SYNCHRONIZED_UNPACED_MS } from "./output-pacer.ts";

/** Animation frames that run only when the test says so. */
function manualFrames() {
  const frames: (() => void)[] = [];
  const frame: FrameTimer = (run) => {
    frames.push(run);
    return () => frames.splice(frames.indexOf(run), 1);
  };
  return { frame, frames, nextFrame: (): void => frames.shift()?.() };
}

/** Timers on a clock that moves only when the test advances it; due timers run in order of when they are due. */
function manualTimers() {
  let now = 0;
  const due: { at: number; run: () => void }[] = [];
  const timer = (run: () => void, ms: number): (() => void) => {
    const entry = { at: now + ms, run };
    due.push(entry);
    return () => {
      const at = due.indexOf(entry);
      if (at !== -1) due.splice(at, 1);
    };
  };
  const advance = (ms: number): void => {
    const until = now + ms;
    for (;;) {
      const next = due.filter((entry) => entry.at <= until).toSorted((a, b) => a.at - b.at)[0];
      if (next === undefined) break;
      due.splice(due.indexOf(next), 1);
      now = next.at;
      next.run();
    }
    now = until;
  };
  return { timer, advance, now: () => now };
}

const KIB = 1024;

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
    // The update is larger than a catch-up frame's bytes, so the frame has no room left for what follows it.
    pacer.push(new Uint8Array([...text(OPEN), ...bytes(FRAME_BYTES * 20)]));
    pacer.push(text(CLOSE));
    pacer.push(bytes(FRAME_BYTES + 1));
    clock.nextFrame();
    expect(written).toEqual([OPEN.length + FRAME_BYTES * 20 + CLOSE.length]);
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

describe("OutputPacer while the app is hidden (D5)", () => {
  test("a drain every 50 ms writes the whole queue at once, credited, with no frame booked", () => {
    const frames = manualFrames();
    const timers = manualTimers();
    const written: number[] = [];
    let credited = 0;
    const credit = (count: number): void => void (credited += count);
    const pacer = new OutputPacer((batch) => written.push(batch.byteLength), frames.frame, timers.now, timers.timer);
    pacer.setHidden(true);
    for (let at = 0; at < 3; at += 1) pacer.push(bytes(20 * KIB), credit);
    expect(frames.frames).toHaveLength(0);
    timers.advance(49);
    expect(written).toEqual([]);
    timers.advance(1);
    expect(written).toEqual([60 * KIB]);
    expect(credited).toBe(60 * KIB);
    expect(frames.frames).toHaveLength(0);
    // The drain goes on while the app stays hidden.
    pacer.push(bytes(KIB), credit);
    timers.advance(50);
    expect(written).toEqual([60 * KIB, KIB]);
    expect(frames.frames).toHaveLength(0);
  });

  test("shown again, what waited is written at once, and later output is paced again", () => {
    const frames = manualFrames();
    const timers = manualTimers();
    const written: number[] = [];
    let credited = 0;
    const pacer = new OutputPacer((batch) => written.push(batch.byteLength), frames.frame, timers.now, timers.timer);
    pacer.setHidden(true);
    pacer.push(bytes(5 * KIB), (count) => (credited += count));
    pacer.setHidden(false);
    expect(written).toEqual([5 * KIB]);
    expect(credited).toBe(5 * KIB);
    expect(pacer.busy).toBe(false);
    timers.advance(50);
    expect(written).toEqual([5 * KIB]);
    pacer.push(bytes(20 * KIB));
    expect(written).toEqual([5 * KIB]);
    frames.nextFrame();
    expect(written).toEqual([5 * KIB, FRAME_BYTES]);
  });

  test("a pane out of view takes nothing while the app is hidden either", () => {
    const frames = manualFrames();
    const timers = manualTimers();
    const written: number[] = [];
    const pacer = new OutputPacer((batch) => written.push(batch.byteLength), frames.frame, timers.now, timers.timer);
    pacer.setVisible(false);
    pacer.setHidden(true);
    pacer.push(bytes(KIB));
    timers.advance(100);
    pacer.setHidden(false);
    expect(written).toEqual([]);
    pacer.setVisible(true);
    frames.nextFrame();
    expect(written).toEqual([KIB]);
  });
});

describe("OutputPacer catching up a backlog (D5)", () => {
  test("back in the app, a backlog over two frames' bytes is written in one frame, up to one credit window, in order", () => {
    const frames = manualFrames();
    const timers = manualTimers();
    const written: Uint8Array[] = [];
    const pacer = new OutputPacer((batch) => written.push(batch), frames.frame, timers.now, timers.timer);
    pacer.setHidden(true);
    pacer.setHidden(false);
    const pushed = [bytes(100 * KIB, 0x61), bytes(100 * KIB, 0x62), bytes(100 * KIB, 0x63)];
    for (const piece of pushed) pacer.push(piece);
    frames.nextFrame();
    expect(written.map((batch) => batch.byteLength)).toEqual([256 * KIB]);
    while (frames.frames.length > 0) frames.nextFrame();
    expect(Buffer.concat(written).equals(Buffer.concat(pushed))).toBe(true);
  });

  test("a steady flood while the app is in view is written at most FRAME_BYTES a frame, however deep its queue (#560)", () => {
    const frames = manualFrames();
    const written: number[] = [];
    const pacer = new OutputPacer(
      (batch) => written.push(batch.byteLength),
      frames.frame,
      () => 0,
    );
    // The program keeps more than two frames' bytes queued: each frame, as much arrives as a frame writes, and more.
    pacer.push(bytes(64 * KIB));
    for (let frame = 0; frame < 20; frame += 1) {
      frames.nextFrame();
      pacer.push(bytes(20 * KIB));
    }
    expect(written).toHaveLength(20);
    expect(written.filter((size) => size > FRAME_BYTES)).toEqual([]);
  });

  test("coming back, what waited lands at once and the window in flight in a catch-up frame; then a flood is paced", () => {
    const frames = manualFrames();
    const timers = manualTimers();
    const written: number[] = [];
    const pacer = new OutputPacer((batch) => written.push(batch.byteLength), frames.frame, timers.now, timers.timer);
    pacer.setHidden(true);
    pacer.push(bytes(300 * KIB));
    pacer.setHidden(false);
    expect(written).toEqual([300 * KIB]);
    // The credit just returned lets the core send what the program wrote meanwhile.
    pacer.push(bytes(300 * KIB));
    frames.nextFrame();
    expect(written.slice(1)).toEqual([256 * KIB]);
    // The backlog is caught up: the flood that goes on is paced again.
    for (let frame = 0; frame < 10; frame += 1) {
      frames.nextFrame();
      pacer.push(bytes(20 * KIB));
    }
    expect(written.slice(2).filter((size) => size > FRAME_BYTES)).toEqual([]);
  });

  test("after a reattach replay, a backlog is caught up in one frame", () => {
    const { frames, timers, written, holds, pacer } = replaying(300);
    timers.advance(500);
    expect(holds).toEqual([true, false]);
    pacer.push(bytes(100 * KIB));
    frames.nextFrame();
    expect(written).toEqual([100 * KIB]);
  });

  test("a queue at or under two frames' bytes is still paced a frame's bytes at a time", () => {
    const frames = manualFrames();
    const written: number[] = [];
    const pacer = new OutputPacer(
      (batch) => written.push(batch.byteLength),
      frames.frame,
      () => 0,
    );
    pacer.push(bytes(20 * KIB));
    frames.nextFrame();
    frames.nextFrame();
    expect(written).toEqual([FRAME_BYTES, 4 * KIB]);
  });
});

/** A pacer in an attach replay, on manual frames and timers, recording what it writes and each hold. */
function replaying(srtt: number | undefined) {
  const frames = manualFrames();
  const timers = manualTimers();
  const written: number[] = [];
  const holds: boolean[] = [];
  const pacer = new OutputPacer((batch) => written.push(batch.byteLength), frames.frame, timers.now, timers.timer);
  pacer.replay({ srtt: () => srtt, hold: (held) => holds.push(held) });
  return { frames, timers, written, holds, pacer };
}

describe("OutputPacer holding an attach replay (D5)", () => {
  test("the replay is written as it arrives, uncapped, held until it is quiet for 1.5 x SRTT + 50 ms", () => {
    const { frames, timers, written, holds, pacer } = replaying(300);
    expect(holds).toEqual([true]);
    expect(pacer.busy).toBe(true);
    pacer.push(bytes(100 * KIB));
    pacer.push(bytes(200 * KIB));
    expect(written).toEqual([100 * KIB, 200 * KIB]);
    expect(frames.frames).toHaveLength(0);
    timers.advance(499);
    expect(holds).toEqual([true]);
    timers.advance(1);
    expect(holds).toEqual([true, false]);
    expect(pacer.busy).toBe(false);
    // Once it ends, output is paced again.
    pacer.push(bytes(20 * KIB));
    expect(written).toHaveLength(2);
    frames.nextFrame();
    expect(written.slice(2)).toEqual([FRAME_BYTES]);
  });

  test("each push starts the quiet window again; with no SRTT the window is 100 ms", () => {
    const { timers, holds, pacer } = replaying(undefined);
    timers.advance(90);
    pacer.push(bytes(KIB));
    timers.advance(99);
    expect(holds).toEqual([true]);
    timers.advance(1);
    expect(holds).toEqual([true, false]);
  });

  test("a replay that never goes quiet is let go 1500 ms after it began", () => {
    const { timers, holds, written, pacer } = replaying(300);
    for (let at = 0; at < 1500; at += 100) {
      pacer.push(bytes(KIB));
      timers.advance(at === 1400 ? 99 : 100);
    }
    expect(holds).toEqual([true]);
    timers.advance(1);
    expect(holds).toEqual([true, false]);
    expect(written).toHaveLength(15);
  });

  test("a replay that comes one credit window a round trip over a 300 ms relay is held until its last window, past 1500 ms", () => {
    const { timers, holds, written, pacer } = replaying(300);
    // The core hands a replay over 256 KiB a round trip (its credit window): 7 windows are 1.75 MiB over 1800 ms.
    for (let window = 0; window < 7; window += 1) {
      pacer.push(bytes(256 * KIB));
      timers.advance(window === 6 ? 0 : 300);
    }
    expect(holds).toEqual([true]);
    timers.advance(499);
    expect(holds).toEqual([true]);
    timers.advance(1);
    expect(holds).toEqual([true, false]);
    expect(written).toHaveLength(7);
  });

  test("a replay that wrote a credit window in each 1500 ms span is let go at the first span that writes less", () => {
    const { timers, holds, pacer } = replaying(300);
    for (let at = 0; at < 3000; at += 250) {
      pacer.push(bytes(64 * KIB));
      timers.advance(250);
    }
    // 1.5 MiB came over 3 s, a window and more each span; then a prompt trickles in under the quiet window.
    expect(holds).toEqual([true]);
    for (let at = 3000; at < 4500; at += 400) {
      pacer.push(bytes(KIB));
      timers.advance(at + 400 > 4500 ? 4499 - at : 400);
    }
    expect(holds).toEqual([true]);
    timers.advance(1);
    expect(holds).toEqual([true, false]);
  });

  test("a replay is let go once 2 MiB have been written", () => {
    const { holds, pacer, written } = replaying(300);
    pacer.push(bytes(1024 * KIB));
    expect(holds).toEqual([true]);
    pacer.push(bytes(1024 * KIB));
    expect(holds).toEqual([true, false]);
    expect(written).toEqual([1024 * KIB, 1024 * KIB]);
  });

  test("when the replay is let go, the write listeners hear of it after the paint is released, so a view held from the end is placed on the drawn replay", () => {
    const frames = manualFrames();
    const timers = manualTimers();
    const pacer = new OutputPacer(() => {}, frames.frame, timers.now, timers.timer);
    const events: string[] = [];
    pacer.onWrite(() => events.push("write"));
    pacer.replay({ srtt: () => 300, hold: (held) => events.push(held ? "hold" : "release") });
    pacer.push(bytes(KIB));
    expect(events).toEqual(["hold", "write"]);
    timers.advance(500);
    expect(events).toEqual(["hold", "write", "release", "write"]);
  });

  test("a replay let go before any of it was written tells the write listeners nothing: there is no drawn replay to place a view on", () => {
    const frames = manualFrames();
    const timers = manualTimers();
    const pacer = new OutputPacer(() => {}, frames.frame, timers.now, timers.timer);
    const events: string[] = [];
    pacer.onWrite(() => events.push("write"));
    pacer.replay({ srtt: () => 300, hold: (held) => events.push(held ? "hold" : "release") });
    timers.advance(500);
    expect(events).toEqual(["hold", "release"]);
    pacer.push(bytes(KIB));
    frames.nextFrame();
    expect(events).toEqual(["hold", "release", "write"]);
  });

  test("drop ends a replay in flight and lets the paint go", () => {
    const { timers, holds, pacer } = replaying(300);
    pacer.push(bytes(KIB));
    pacer.drop();
    expect(holds).toEqual([true, false]);
    expect(pacer.busy).toBe(false);
    timers.advance(2000);
    expect(holds).toEqual([true, false]);
  });
});

test("the unpaced window is the synchronized-output hold of the @wterm/dom that is installed (#1020)", async () => {
  const bundle = join(dirname(Bun.resolveSync("@wterm/dom", import.meta.dir)), "wterm.js");
  const hold = /\bSYNCHRONIZED_OUTPUT_TIMEOUT_MS = (\d+);/.exec(await Bun.file(bundle).text())?.[1];
  expect(hold).toBeDefined();
  expect(Number(hold)).toBe(SYNCHRONIZED_UNPACED_MS);
});
