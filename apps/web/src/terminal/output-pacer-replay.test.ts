import { describe, expect, test } from "bun:test";
import { FRAME_BYTES, OutputPacer } from "./output-pacer.ts";
import { bytes, CLOSE, KIB, manualFrames, manualTimers, OPEN, text } from "./output-pacer.test-support.ts";

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

  test("a replay that wrote a credit window in each 1500 ms span is let go at the first span that writes a trickle", () => {
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

  test("a replay that comes slower than a window a span, as on a page slow to take each window in, is held to its last frame (#2271)", () => {
    const { timers, holds, written, pacer } = replaying(300);
    // 16 KiB every 125 ms is 128 KiB/s: each 1500 ms span writes 192 KiB, under a credit window, for 1.5 MiB.
    for (let frame = 0; frame < 96; frame += 1) {
      pacer.push(bytes(16 * KIB));
      timers.advance(frame === 95 ? 0 : 125);
    }
    expect(holds).toEqual([true]);
    timers.advance(499);
    expect(holds).toEqual([true]);
    timers.advance(1);
    expect(holds).toEqual([true, false]);
    expect(written).toHaveLength(96);
  });

  test("a span that caught part of a window does not end the hold while the span before wrote a window (#2271)", () => {
    const { timers, holds, pacer } = replaying(300);
    // A window's worth in the first span, 96 KiB in the second (the rest of the next window falls after its end), then
    // the replay goes on.
    for (let at = 0; at < 1500; at += 250) {
      pacer.push(bytes(48 * KIB));
      timers.advance(250);
    }
    for (let at = 1500; at < 3000; at += 250) {
      pacer.push(bytes(16 * KIB));
      timers.advance(250);
    }
    expect(holds).toEqual([true]);
    for (let at = 3000; at < 4500; at += 250) {
      pacer.push(bytes(48 * KIB));
      timers.advance(250);
    }
    expect(holds).toEqual([true]);
  });

  test("a first span that writes under half a credit window, though more than a trickle, lets the replay go (#2271)", () => {
    const { timers, holds, pacer } = replaying(300);
    // 96 KiB over the first span, in frames under the quiet window: more than a trickle, under half a window.
    for (let at = 0; at < 1500; at += 250) {
      pacer.push(bytes(16 * KIB));
      timers.advance(at + 250 >= 1500 ? 249 : 250);
    }
    expect(holds).toEqual([true]);
    timers.advance(1);
    expect(holds).toEqual([true, false]);
  });

  test("two spans that write under a credit window between them, each more than a trickle, let the replay go (#2271)", () => {
    const { timers, holds, pacer } = replaying(300);
    // 132 KiB, then 96 KiB: each more than a trickle, 228 KiB together, under a window.
    for (const [from, frame] of [
      [0, 22],
      [1500, 16],
    ] as const)
      for (let at = from; at < from + 1500; at += 250) {
        pacer.push(bytes(frame * KIB));
        timers.advance(at + 250 >= 3000 ? 249 : 250);
      }
    expect(holds).toEqual([true]);
    timers.advance(1);
    expect(holds).toEqual([true, false]);
  });

  test("a quiet window whose timer ran late because the page stalled is not taken for the replay's end", () => {
    const frames = manualFrames();
    const timers = manualTimers();
    let stalled = 0;
    const holds: boolean[] = [];
    const pacer = new OutputPacer(
      () => {},
      frames.frame,
      () => timers.now() + stalled,
      timers.timer,
    );
    pacer.replay({ srtt: () => 300, hold: (held) => holds.push(held) });
    pacer.push(bytes(256 * KIB));
    // The page ran nothing for 2 s: the quiet window's timer runs that late, with the next window queued behind it.
    stalled = 2000;
    timers.advance(500);
    expect(holds).toEqual([true]);
    pacer.push(bytes(256 * KIB));
    timers.advance(499);
    expect(holds).toEqual([true]);
    timers.advance(1);
    expect(holds).toEqual([true, false]);
  });

  test("the quiet window starts when a window's credit goes back, so a page slow to write each window is held to the last (#2011)", () => {
    const frames = manualFrames();
    const timers = manualTimers();
    const holds: boolean[] = [];
    // Writing each 256 KiB window takes the page 300 ms (a starved page drawing a colored replay); its credit goes back
    // as the write ends, and the core sends the next window only then.
    const pacer = new OutputPacer(() => timers.advance(300), frames.frame, timers.now, timers.timer);
    pacer.replay({ srtt: () => 300, hold: (held) => holds.push(held) });
    for (let window = 0; window < 4; window += 1) {
      pacer.push(bytes(256 * KIB));
      // The next window comes a round trip after the credit: 600 ms after the last one arrived, past 1.5 x SRTT + 50.
      if (window < 3) timers.advance(300);
    }
    expect(holds).toEqual([true]);
    timers.advance(499);
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

  test("a synchronized update stands the replay down: its own bracket paints it, not a second hold (#812)", () => {
    const { frames, timers, written, holds, pacer } = replaying(100);
    expect(holds).toEqual([true]);
    // The core brackets its first paint: the update already holds the paint, so the replay ends as the bracket opens.
    pacer.push(new Uint8Array([...text(OPEN), ...bytes(100 * KIB)]));
    expect(written).toEqual([OPEN.length + 100 * KIB]);
    expect(holds).toEqual([true, false]);
    expect(pacer.busy).toBe(false);
    // The open bracket is still written as it arrives, as the pacer already writes one, and no hold comes back.
    pacer.push(bytes(FRAME_BYTES * 2));
    expect(written).toEqual([OPEN.length + 100 * KIB, FRAME_BYTES * 2]);
    // Once it closes, what follows waits for a frame like any other output.
    pacer.push(new Uint8Array([...text(CLOSE), ...bytes(FRAME_BYTES)]));
    expect(written.at(-1)).toBe(CLOSE.length);
    while (frames.frames.length > 0) frames.nextFrame();
    expect(written.reduce((sum, size) => sum + size, 0)).toBe(OPEN.length + 100 * KIB + FRAME_BYTES * 3 + CLOSE.length);
    // The replay's own timers are gone: neither its quiet window nor its cap holds the paint again.
    timers.advance(10_000);
    expect(holds).toEqual([true, false]);
  });

  test("an update that opens and closes in one push still stands the replay down (#812)", () => {
    const { frames, timers, written, holds, pacer } = replaying(100);
    expect(holds).toEqual([true]);
    // The whole bracketed first paint arrives as one chunk: the update has already closed when the batch is written.
    pacer.push(new Uint8Array([...text(OPEN), ...bytes(100 * KIB), ...text(CLOSE)]));
    while (frames.frames.length > 0) frames.nextFrame();
    expect(written.reduce((sum, size) => sum + size, 0)).toBe(OPEN.length + 100 * KIB + CLOSE.length);
    expect(holds).toEqual([true, false]);
    expect(pacer.busy).toBe(false);
    timers.advance(10_000);
    expect(holds).toEqual([true, false]);
  });

  test("after a reattach replay, a backlog is caught up in one frame", () => {
    const { frames, timers, written, holds, pacer } = replaying(300);
    timers.advance(500);
    expect(holds).toEqual([true, false]);
    pacer.push(bytes(100 * KIB));
    frames.nextFrame();
    expect(written).toEqual([100 * KIB]);
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
