import { describe, expect, test } from "bun:test";
import { DUE_MAX_MS, DUE_MIN_MS, predictionDue } from "./prediction.ts";
import { confirmed, harness } from "./testing/prediction-harness.ts";

const texts = (h: ReturnType<typeof harness>): string[] => h.predictor.visible().map((cell) => cell.text);
/** `due` at the harness's srtt of 250 ms: 1.5 * 250 + 120. */
const DUE = 495;

describe("predictionDue", () => {
  test("is clamp(1.5 * srtt + 120, 200, 1500) ms, and the ceiling without an estimate", () => {
    expect(predictionDue({ srtt: 250 })).toBe(495);
    expect(predictionDue({ srtt: 60 })).toBe(210);
    expect(predictionDue({ srtt: 1 })).toBe(DUE_MIN_MS);
    expect(predictionDue({ srtt: 2000 })).toBe(DUE_MAX_MS);
    expect(predictionDue(undefined)).toBe(DUE_MAX_MS);
  });
});

describe("confirmation by screen content, bounded by `due` (design note D2)", () => {
  test("a different cell before `due` keeps the prediction; the same cell after `due` kills the epoch", () => {
    const h = harness();
    confirmed(h);
    h.predictor.typed("a", "key");
    h.clock.now += DUE - 1;
    h.hostEchoes("x");
    expect(texts(h)).toEqual(["a"]);
    h.clock.now += 1;
    h.predictor.wrote();
    expect(texts(h)).toEqual([]);
    h.predictor.typed("y", "key");
    expect(texts(h)).toEqual([]);
  });

  test("tick() keeps an unechoed prediction until `due` and kills it at `due`", () => {
    const h = harness();
    confirmed(h);
    h.predictor.typed("a", "key");
    h.predictor.tick(h.clock.now + DUE - 1);
    expect(texts(h)).toEqual(["a"]);
    h.predictor.tick(h.clock.now + DUE);
    expect(texts(h)).toEqual([]);
  });

  test("`due` follows the current srtt: at srtt 1000 the same wait is still in time", () => {
    const h = harness();
    confirmed(h);
    h.predictor.typed("a", "key");
    h.link.srtt = 1000;
    h.predictor.tick(h.clock.now + DUE + 500);
    expect(texts(h)).toEqual(["a"]);
    h.predictor.tick(h.clock.now + DUE_MAX_MS);
    expect(texts(h)).toEqual([]);
  });

  test("the cursor leaving the predictions' row kills the epoch at once, before `due`", () => {
    const h = harness();
    confirmed(h);
    h.predictor.typed("a", "key");
    h.screen.at = { row: 1, col: 0 };
    h.predictor.wrote();
    expect(texts(h)).toEqual([]);
    h.predictor.typed("b", "key");
    expect(texts(h)).toEqual([]);
  });

  test("the alternate screen turning on kills the epoch, so leaving it again starts unconfirmed", () => {
    const h = harness();
    confirmed(h);
    h.predictor.typed("a", "key");
    h.screen.alt = true;
    h.predictor.wrote();
    expect(texts(h)).toEqual([]);
    h.screen.alt = false;
    h.predictor.wrote();
    h.predictor.typed("b", "key");
    expect(texts(h)).toEqual([]);
  });

  test("a confirming echo records its latency, now - sentAt", () => {
    const h = harness();
    h.predictor.typed("a", "key");
    h.clock.now += 180;
    h.hostEchoes("a");
    expect(h.echoes).toEqual([180]);
  });

  test("a wide prediction is confirmed by the wide cell the host writes", () => {
    const h = harness();
    confirmed(h);
    h.predictor.typed("가", "key");
    h.predictor.typed("a", "key");
    expect(texts(h)).toEqual(["가", "a"]);
    h.hostEchoes("가");
    expect(h.predictor.visible()).toMatchObject([{ text: "a", col: 3 }]);
    expect(h.echoes).toHaveLength(2);
  });

  test("bytes are read as UTF-8: one key as bytes is predicted like the same key as text", () => {
    const h = harness();
    confirmed(h);
    expect(h.predictor.typed(new TextEncoder().encode("가"), "key")).toMatchObject({ cell: { text: "가", width: 2 } });
  });
});

describe("matches that prove no echo (mosh CorrectNoCredit)", () => {
  test("a space matching a blank cell never confirms an epoch", () => {
    const h = harness();
    h.predictor.typed(" ", "key");
    h.hostEchoes(" ");
    h.predictor.typed("a", "key");
    expect(texts(h)).toEqual([]);
    expect(h.echoes).toEqual([]);
  });

  test("a key over a cell that already shows it never confirms, stays drawn until `due`, then goes without a kill", () => {
    const h = harness();
    h.screen.echo("ab");
    h.screen.at = { row: 0, col: 0 };
    h.predictor.typed("a", "key");
    h.predictor.wrote();
    expect(h.echoes).toEqual([]);
    h.clock.now += DUE;
    h.predictor.tick(h.clock.now);
    expect(h.predictor.typed("b", "key")).toMatchObject({ kind: "predicted", cell: { col: 1 } });
    h.hostEchoes("a");
    h.screen.echo("b");
    h.screen.at = { row: 0, col: 2 };
    h.predictor.wrote();
    expect(h.echoes).toEqual([]);
  });

  test("a key over a different glyph is credited when the host overwrites it", () => {
    const h = harness();
    h.screen.echo("x");
    h.screen.at = { row: 0, col: 0 };
    h.predictor.typed("a", "key");
    h.hostEchoes("a");
    h.predictor.typed("b", "key");
    expect(texts(h)).toEqual(["b"]);
  });
});

describe("visible()", () => {
  test("returns the same array until the predictions change, so a renderer can skip an unchanged frame", () => {
    const h = harness();
    confirmed(h);
    h.predictor.typed("a", "key");
    const first = h.predictor.visible();
    h.predictor.tick(h.clock.now + 1);
    expect(h.predictor.visible()).toBe(first);
    h.predictor.typed("b", "key");
    expect(h.predictor.visible()).not.toBe(first);
  });
});
