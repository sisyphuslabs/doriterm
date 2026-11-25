import { afterEach, expect, jest, test } from "bun:test";
import { ShowGate } from "./show-gate.ts";

afterEach(() => jest.useRealTimers());

function gate(delayMs = 1_000, minMs = 500) {
  jest.useFakeTimers();
  const seen: boolean[] = [];
  const shown = new ShowGate({ delayMs, minMs }, (value) => seen.push(value));
  return { shown, seen };
}

test("a wait that ends before the delay never shows anything", () => {
  const { shown, seen } = gate();
  shown.set(true);
  jest.advanceTimersByTime(999);
  shown.set(false);
  jest.advanceTimersByTime(5_000);
  expect(seen).toEqual([]);
  expect(shown.shown).toBe(false);
});

test("a wait that outlasts the delay shows once, at the delay", () => {
  const { shown, seen } = gate();
  shown.set(true);
  jest.advanceTimersByTime(999);
  expect(seen).toEqual([]);
  jest.advanceTimersByTime(1);
  expect(seen).toEqual([true]);
  expect(shown.shown).toBe(true);
});

test("once shown it stays for the minimum, even when the wait ends right after the delay", () => {
  const { shown, seen } = gate();
  shown.set(true);
  jest.advanceTimersByTime(1_050);
  shown.set(false);
  expect(seen).toEqual([true]);
  jest.advanceTimersByTime(449);
  expect(shown.shown).toBe(true);
  jest.advanceTimersByTime(1);
  expect(seen).toEqual([true, false]);
});

test("a wait that ends after the minimum hides at once", () => {
  const { shown, seen } = gate();
  shown.set(true);
  jest.advanceTimersByTime(3_000);
  shown.set(false);
  expect(seen).toEqual([true, false]);
});

test("a new wait during the minimum keeps it shown, with no blink", () => {
  const { shown, seen } = gate();
  shown.set(true);
  jest.advanceTimersByTime(1_100);
  shown.set(false);
  jest.advanceTimersByTime(200);
  shown.set(true);
  jest.advanceTimersByTime(5_000);
  expect(seen).toEqual([true]);
  shown.set(false);
  expect(seen).toEqual([true, false]);
});

test("stop cancels a pending show", () => {
  const { shown, seen } = gate();
  shown.set(true);
  shown.stop();
  jest.advanceTimersByTime(5_000);
  expect(seen).toEqual([]);
});
