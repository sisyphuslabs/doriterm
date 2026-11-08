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

interface Run {
  readonly h: ReturnType<typeof harness>;
  /** Keys drawn the moment they were typed, and keys typed after the first echo had landed. */
  readonly drawn: number;
  readonly afterFirstEcho: number;
}

/**
 * Types 200 keys 70 ms apart while the host echoes each 270-400 ms later (uniform, per key) without ever letting an echo
 * overtake the one before it, and ticks the predictor every 16 ms frame, as `HcSocket.delay` in a jittered,
 * order-preserving mode would deliver them.
 */
function jitteredRun(cols: number): Run {
  const h = harness();
  h.link.mode = "adaptive";
  h.screen.width = cols;
  const random = seeded(1439);
  const text = "echo predict-ok ".repeat(13).slice(0, KEYS);
  const steps: { readonly at: number; readonly order: number; readonly run: () => void }[] = [];
  let drawn = 0;
  let arrival = 0;
  let firstEcho = Number.POSITIVE_INFINITY;
  const typedAt: number[] = [];
  for (let index = 0; index < KEYS; index += 1) {
    const key = text.charAt(index);
    const sentAt = 1000 + index * CADENCE_MS;
    arrival = Math.max(arrival, sentAt + 270 + random() * 130);
    firstEcho = Math.min(firstEcho, arrival);
    typedAt.push(sentAt);
    steps.push({
      at: sentAt,
      order: 1,
      run: () => {
        const verdict = h.predictor.typed(key, "key");
        if (verdict.kind !== "predicted") return;
        const { row, col } = verdict.cell;
        if (h.predictor.visible().some((cell) => cell.row === row && cell.col === col)) drawn += 1;
      },
    });
    steps.push({ at: arrival, order: 0, run: () => h.hostEchoes(key) });
  }
  for (let frame = 1000; frame <= arrival + 2 * FRAME_MS; frame += FRAME_MS) {
    steps.push({ at: frame, order: 2, run: () => h.predictor.tick(frame) });
  }
  steps.sort((first, second) => first.at - second.at || first.order - second.order);
  for (const step of steps) {
    h.clock.now = step.at;
    step.run();
  }
  return { h, drawn, afterFirstEcho: typedAt.filter((at) => at >= firstEcho).length };
}

describe("an order-preserving 270-400 ms jitter at a 70 ms typing cadence (#1439 HIGH 1)", () => {
  test("on one row: no judgement of any kind, and every key typed after the first echo is drawn at once", () => {
    const { h, drawn, afterFirstEcho } = jitteredRun(256);
    console.log(
      `one row: drawn ${drawn}, typed after the first echo ${afterFirstEcho}, events ${judgements(h).length}`,
    );
    expect(judgements(h)).toEqual([]);
    expect(drawn).toBe(afterFirstEcho);
    expect(h.predictor.visible()).toEqual([]);
  });

  test("across line wraps: zero resets; refused keys at the margin only ever kill undrawn epochs", () => {
    const { h, drawn } = jitteredRun(80);
    const events = judgements(h);
    console.log(`wrapping: drawn ${drawn}/${KEYS}, events ${JSON.stringify(events)}`);
    expect(events.filter((event) => event.startsWith("reset"))).toEqual([]);
    expect(events.every((event) => event.startsWith("killEpoch"))).toBe(true);
  });
});
