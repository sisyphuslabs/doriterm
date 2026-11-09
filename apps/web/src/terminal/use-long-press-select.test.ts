import { afterEach, describe, expect, jest, test } from "bun:test";
import type { WTerm } from "@wterm/react";
import { LONG_PRESS_MS } from "./long-press.ts";
import { type LongPressTerminal, longPressTerminal } from "./long-press-harness.test-support.ts";
import { attachLongPressSelect } from "./use-long-press-select.ts";

const mounted: LongPressTerminal[] = [];
const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
  for (const terminal of mounted.splice(0)) terminal.restore();
  jest.useRealTimers();
});

/** A terminal wired as the terminal view wires it through useLongPressSelect, unwired after the test. */
function wiredTerminal(): LongPressTerminal {
  jest.useFakeTimers();
  const terminal = longPressTerminal();
  mounted.push(terminal);
  // The fake terminal's element is a hand-built node with a row of text, enough for every gesture the hook reads.
  unmounts.push(attachLongPressSelect(terminal.wt as unknown as Pick<WTerm, "element">, () => undefined));
  return terminal;
}

describe("the held-press mark lives for one touch (#854)", () => {
  test("a picked press cancels its own lift's tap", () => {
    const terminal = wiredTerminal();
    terminal.down();
    jest.advanceTimersByTime(LONG_PRESS_MS);
    terminal.up();
    expect(terminal.tapCancelled).toBe(true);
  });

  test("a press after that gesture makes the next touch a tap again", () => {
    const terminal = wiredTerminal();
    terminal.down();
    jest.advanceTimersByTime(LONG_PRESS_MS);
    terminal.up();
    expect(terminal.tapCancelled).toBe(true);

    terminal.down(2);
    terminal.up(2);
    expect(terminal.tapCancelled).toBe(false);
  });

  test("a second finger beside the first leaves that first lift cancelled", () => {
    const terminal = wiredTerminal();
    terminal.down(1);
    jest.advanceTimersByTime(LONG_PRESS_MS);
    terminal.down(2, false);
    terminal.up(1);
    expect(terminal.tapCancelled).toBe(true);
  });
});
