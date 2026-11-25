import { expect, test } from "bun:test";
import { PINCH_MAX_PT, PINCH_MIN_PT, pinchedSize, TwoFingerDoubleTap } from "./pinch-font.ts";

test("each x1.06 of finger distance is one 0.5 pt step, either way", () => {
  expect(pinchedSize(13, 100, 106.01)).toBe(13.5);
  expect(pinchedSize(13, 100, 100 * 1.06 ** 2 + 0.01)).toBe(14);
  expect(pinchedSize(13, 100, 100 / 1.06 - 0.01)).toBe(12.5);
  expect(pinchedSize(13, 100, 100 / 1.06 ** 4 - 0.01)).toBe(11);
});

test("a movement smaller than one step keeps the size", () => {
  expect(pinchedSize(13, 100, 105)).toBe(13);
  expect(pinchedSize(13, 100, 95)).toBe(13);
});

test("the size stops at 8 and 24 pt", () => {
  expect(PINCH_MIN_PT).toBe(8);
  expect(PINCH_MAX_PT).toBe(24);
  expect(pinchedSize(13, 100, 10_000)).toBe(24);
  expect(pinchedSize(13, 100, 1)).toBe(8);
});

test("a start between half points lands on the half-point grid", () => {
  expect(pinchedSize(13.2, 100, 106.01)).toBe(13.5);
});

const fingers = (n: number, x = 100) => Array.from({ length: n }, (_, i) => ({ x: x + i * 50, y: 300 }));

test("two quick two-finger taps reset; one does not", () => {
  const taps = new TwoFingerDoubleTap();
  expect(taps.start(fingers(2), 0)).toBe(false);
  expect(taps.end(0, 80)).toBe(false);
  expect(taps.start(fingers(2), 200)).toBe(false);
  expect(taps.end(0, 260)).toBe(true);
  // The pair is used up: a third tap starts over.
  expect(taps.start(fingers(2), 400)).toBe(false);
  expect(taps.end(0, 450)).toBe(false);
});

test("a one-finger double tap, a slow second tap, or a moved pair is no reset", () => {
  const one = new TwoFingerDoubleTap();
  one.start(fingers(1), 0);
  one.end(0, 50);
  one.start(fingers(1), 120);
  expect(one.end(0, 170)).toBe(false);

  const slow = new TwoFingerDoubleTap();
  slow.start(fingers(2), 0);
  slow.end(0, 60);
  slow.start(fingers(2), 800);
  expect(slow.end(0, 860)).toBe(false);

  const moved = new TwoFingerDoubleTap();
  moved.start(fingers(2), 0);
  moved.end(0, 60);
  moved.start(fingers(2), 150);
  moved.move(fingers(2, 160));
  expect(moved.end(0, 200)).toBe(false);
});
