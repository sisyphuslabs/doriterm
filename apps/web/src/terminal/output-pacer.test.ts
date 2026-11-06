import { describe, expect, test } from "bun:test";
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

const bytes = (length: number, fill = 0x61) => new Uint8Array(length).fill(fill);

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
