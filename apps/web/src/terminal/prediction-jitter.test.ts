import { describe, expect, test } from "bun:test";
import { harness, judgements } from "./testing/prediction-harness.ts";

/** mulberry32: a seeded generator, so the run is the same every time. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const KEYS = 200;
const CADENCE_MS = 70;
const FRAME_MS = 16;
const TEXT = "echo predict-ok ".repeat(13).slice(0, KEYS);

interface Measured {
  readonly resets: number;
  readonly judgements: readonly string[];
  readonly confirmed: number;
  /**
   * Host writes at which a drawn key was still unechoed and older than the shortest echo round trip seen so far: the
   * moments a time-judged model (the review's `now >= sentAt + minRtt`) declares that key wrong and resets. A run with
   * none of them cannot tell the two models apart.
   */
  readonly judgementPoints: number;
  readonly drawn: number;
  /** Keys typed after the frame that wrote the first echo, which confirms the epoch. */
  readonly typedAfterFirstEcho: number;
}

/**
 * Types 200 keys 70 ms apart. The host echoes each 270-400 ms later (uniform, per key) and never lets an echo overtake
 * the one before it, as `HcSocket.delay` would in a jittered, order-preserving mode; the echoes that have arrived by a
 * 16 ms frame are written together on that frame, as the output pacer writes them, and the predictor ticks every frame.
 */
function jitteredRun(layout: { readonly cols: number; readonly startRow: number }): Measured {
  const h = harness();
  h.link.mode = "adaptive";
  h.screen.width = layout.cols;
  h.screen.at = { row: layout.startRow, col: 0 };
  const random = seeded(1439);
  const sentAt: number[] = [];
  const arrival: number[] = [];
  for (let index = 0; index < KEYS; index += 1) {
    sentAt.push(1000 + index * CADENCE_MS);
    arrival.push(Math.max(arrival.at(-1) ?? 0, 1000 + index * CADENCE_MS + 270 + random() * 130));
  }
  const keyAt = new Map<string, number>();
  let typed = 0;
  let echoed = 0;
  let drawn = 0;
  let judgementPoints = 0;
  let minRtt = Number.POSITIVE_INFINITY;
  let firstWrite = Number.POSITIVE_INFINITY;
  const end = (arrival.at(-1) ?? 0) + 2 * FRAME_MS;
  for (let frame = 1000; frame <= end; frame += 1) {
    h.clock.now = frame;
    while (typed < KEYS && sentAt[typed] === frame) {
      const verdict = h.predictor.typed(TEXT.charAt(typed), "key");
      if (verdict.kind === "predicted") {
        const { row, col } = verdict.cell;
        keyAt.set(`${row}:${col}`, typed);
        if (h.predictor.visible().some((cell) => cell.row === row && cell.col === col)) drawn += 1;
      }
      typed += 1;
    }
    if ((frame - 1000) % FRAME_MS !== 0) continue;
    let batch = "";
    while (echoed < KEYS && (arrival[echoed] ?? end) <= frame) {
      minRtt = Math.min(minRtt, frame - (sentAt[echoed] ?? frame));
      batch += TEXT.charAt(echoed);
      echoed += 1;
    }
    if (batch !== "") {
      firstWrite = Math.min(firstWrite, frame);
      const before = h.predictor.visible();
      h.screen.echo(batch);
      const exposed = before.some((cell) => {
        const key = keyAt.get(`${cell.row}:${cell.col}`) ?? 0;
        const shown = String.fromCodePoint(h.screen.cell(cell.row, cell.col).char) === cell.text;
        return !shown && frame - (sentAt[key] ?? frame) >= minRtt;
      });
      if (exposed) judgementPoints += 1;
      h.predictor.wrote();
    }
    h.predictor.tick(frame);
  }
  const events = judgements(h);
  return {
    resets: events.filter((event) => event.startsWith("reset")).length,
    judgements: events,
    confirmed: h.events.filter((event) => event.kind === "confirmed").length,
    judgementPoints,
    drawn,
    typedAfterFirstEcho: sentAt.filter((at) => at > firstWrite).length,
  };
}

describe("an order-preserving 270-400 ms jitter at a 70 ms typing cadence, 200 keys (#1439 HIGH 1)", () => {
  test("on one row: the run is live, every key after the first echo is drawn at once, and nothing resets", () => {
    const run = jitteredRun({ cols: 256, startRow: 0 });
    console.log(`one row: ${JSON.stringify(run)}`);
    expect(run.judgementPoints).toBeGreaterThan(0);
    expect(run.confirmed).toBe([...TEXT].filter((key) => key !== " ").length);
    expect(run.drawn).toBe(run.typedAfterFirstEcho);
    expect(run.resets).toBe(0);
  });

  test("wrapping at 80 columns: the run is live, nothing resets, and the wraps cost under a quarter of the keys", () => {
    const run = jitteredRun({ cols: 80, startRow: 0 });
    console.log(`wrapping: ${JSON.stringify(run)}`);
    expect(run.judgementPoints).toBeGreaterThan(0);
    expect(run.resets).toBe(0);
    expect(run.drawn).toBeGreaterThan(run.typedAfterFirstEcho * 0.75);
  });

  test("wrapping on the last row, which scrolls: the run is live, nothing resets, the wraps cost under a quarter", () => {
    const run = jitteredRun({ cols: 80, startRow: 23 });
    console.log(`last row: ${JSON.stringify(run)}`);
    expect(run.judgementPoints).toBeGreaterThan(0);
    expect(run.resets).toBe(0);
    expect(run.drawn).toBeGreaterThan(run.typedAfterFirstEcho * 0.75);
  });
});
