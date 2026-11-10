import { describe, expect, test } from "bun:test";
import { CREDIT_WINDOW_BYTES, type FrameTimer, OutputPacer, REPLAY_CAP_MS } from "./output-pacer.ts";

const neverFrame: FrameTimer = () => () => undefined;

/** A pacer whose frames never run and whose timers move only when the test advances them, recording paint holds. */
function pacerOutOfView() {
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
  const written: number[] = [];
  const holds: boolean[] = [];
  const pacer = new OutputPacer(
    (batch) => written.push(batch.byteLength),
    neverFrame,
    () => now,
    timer,
  );
  pacer.setVisible(false);
  pacer.replay({ srtt: () => 300, hold: (held) => holds.push(held) });
  return { pacer, written, holds, advance };
}

describe("OutputPacer holding a replay that began out of view (#2025)", () => {
  test("a replay stopped at the credit window while hidden is still held when it shows, until it settles in view", () => {
    const { pacer, written, holds, advance } = pacerOutOfView();
    // Hidden, nothing is written or credited: the core sends one credit window and waits.
    pacer.push(new Uint8Array(CREDIT_WINDOW_BYTES));
    advance(REPLAY_CAP_MS * 4);
    expect(written).toEqual([]);
    expect(holds).toEqual([true]);
    expect(pacer.holding).toBe(true);

    // Shown: the window is written at once, its credit goes back, and the rest of the replay comes a round trip later.
    pacer.setVisible(true);
    expect(written).toEqual([CREDIT_WINDOW_BYTES]);
    advance(300);
    pacer.push(new Uint8Array(64 * 1024));
    expect(holds).toEqual([true]);
    // Quiet for 1.5 x SRTT + 50 ms after its last bytes, in view: the replay is drawn whole.
    advance(499);
    expect(holds).toEqual([true]);
    advance(1);
    expect(holds).toEqual([true, false]);
    expect(pacer.holding).toBe(false);
  });

  test("a replay that came whole while hidden is drawn as the terminal shows, with no wait", () => {
    const { pacer, written, holds, advance } = pacerOutOfView();
    pacer.push(new Uint8Array(4 * 1024));
    advance(REPLAY_CAP_MS);
    pacer.setVisible(true);
    expect(written).toEqual([4 * 1024]);
    expect(holds).toEqual([true, false]);
  });

  test("output still arriving as the terminal shows is held until it goes quiet, at most one quiet window", () => {
    const { pacer, holds, advance } = pacerOutOfView();
    pacer.push(new Uint8Array(1024));
    advance(80);
    pacer.setVisible(true);
    expect(holds).toEqual([true]);
    // A spinner: a few bytes every 80 ms never goes quiet, and is let go one quiet window (1.5 x 300 + 50 ms) after it shows.
    for (let at = 0; at < 480; at += 80) {
      pacer.push(new Uint8Array(16));
      advance(80);
    }
    expect(holds).toEqual([true]);
    advance(20);
    expect(holds).toEqual([true, false]);
  });

  test("hidden again before it settles, the hold waits for the next time the terminal shows", () => {
    const { pacer, holds, advance } = pacerOutOfView();
    pacer.push(new Uint8Array(CREDIT_WINDOW_BYTES));
    pacer.setVisible(true);
    advance(100);
    pacer.setVisible(false);
    advance(REPLAY_CAP_MS * 2);
    expect(holds).toEqual([true]);
    pacer.push(new Uint8Array(CREDIT_WINDOW_BYTES));
    pacer.setVisible(true);
    advance(499);
    expect(holds).toEqual([true]);
    advance(1);
    expect(holds).toEqual([true, false]);
  });
});
