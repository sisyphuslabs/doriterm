import { afterEach, describe, expect, jest, mock, test } from "bun:test";
import type { WTerm } from "@wterm/react";
import { LONG_PRESS_MS } from "./long-press.ts";
import { type LongPressTerminal, longPressTerminal } from "./long-press-harness.test-support.ts";

// The hook only uses an effect and a ref, and bun has no renderer: these run the effect once and hand back a ref, so
// the test drives the listeners the effect wired instead of a React tree.
const cleanups: (() => void)[] = [];
mock.module("react", () => ({
  useEffect: (effect: () => (() => void) | undefined): void => {
    const cleanup = effect();
    if (cleanup !== undefined) cleanups.push(cleanup);
  },
  useRef: <T>(value: T): { current: T } => ({ current: value }),
}));
const { useLongPressSelect } = await import("./use-long-press-select.ts");

let mounted: LongPressTerminal | undefined;
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  mounted?.restore();
  mounted = undefined;
  jest.useRealTimers();
});

function press(): { readonly terminal: LongPressTerminal; readonly menus: () => number } {
  jest.useFakeTimers();
  const harness = longPressTerminal();
  mounted = harness;
  let opened = 0;
  useLongPressSelect(harness.wt as unknown as WTerm, () => {
    opened += 1;
  });
  return { terminal: harness, menus: () => opened };
}

describe("the held-press mark lives for one touch (#854)", () => {
  test("a picked press cancels its own lift's tap", () => {
    const { terminal, menus } = press();
    terminal.down();
    jest.advanceTimersByTime(LONG_PRESS_MS);
    expect(terminal.up()).toBe(true);
    expect(menus()).toBe(1);
  });

  test("a press after that gesture makes the next touch a tap again", () => {
    const { terminal } = press();
    terminal.down();
    jest.advanceTimersByTime(LONG_PRESS_MS);
    expect(terminal.up()).toBe(true);

    terminal.down(2);
    expect(terminal.up(2)).toBe(false);
  });

  test("a second finger beside the first leaves that first lift cancelled", () => {
    const { terminal } = press();
    terminal.down(1);
    jest.advanceTimersByTime(LONG_PRESS_MS);
    terminal.down(2, false);
    expect(terminal.up(1)).toBe(true);
  });
});
