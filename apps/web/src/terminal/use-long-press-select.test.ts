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

  test("a picked press on a cell the program redraws away still cancels its own lift's tap (#2057)", () => {
    const terminal = wiredTerminal();
    terminal.down(1, true, true);
    jest.advanceTimersByTime(LONG_PRESS_MS);
    terminal.up(1);
    expect(terminal.tapCancelled).toBe(true);
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

describe("a picked drag keeps every finger's moves (#2096)", () => {
  test("the dragging finger's moves are cancelled, so the browser never pans the drag away", () => {
    const terminal = wiredTerminal();
    terminal.down(1);
    jest.advanceTimersByTime(LONG_PRESS_MS);
    expect(terminal.move(1)).toBe(true);
  });

  test("a second finger landing on another cell and moving on its own is cancelled too, so it cannot pinch the drag away", () => {
    const terminal = wiredTerminal();
    terminal.down(1);
    jest.advanceTimersByTime(LONG_PRESS_MS);
    // Each finger's moves go to the node that finger came down on: the second one's are never the first one's node's.
    terminal.down(2, false, true);
    expect(terminal.move(2)).toBe(true);
    terminal.up(2, false);
    expect(terminal.move(1)).toBe(true);
  });

  test("before the hold has picked its word, no finger's moves are cancelled: the touch is still a scroll or a tap", () => {
    const terminal = wiredTerminal();
    terminal.down(1);
    terminal.down(2, false, true);
    expect(terminal.move(1)).toBe(false);
    expect(terminal.move(2)).toBe(false);
  });
});

/** Every event the hook listens for, each sent once by a press held, moved and lifted, then cancelled. */
const GESTURE = ["pointerdown", "touchstart", "pointermove", "touchmove", "pointerup", "touchend", "pointercancel"];
/** What a press sends after its finger is down: what an unwiring in the middle of the press must leave unanswered. */
const AFTER_DOWN = GESTURE.filter((type) => type !== "pointerdown" && type !== "touchstart");

/** A terminal the hook is wired to, unwired `before` the press, `during` it (after the finger is down) or `never`. */
function pressed(unwire: "before" | "during" | "never"): LongPressTerminal {
  jest.useFakeTimers();
  const terminal = longPressTerminal();
  mounted.push(terminal);
  const detach = attachLongPressSelect(terminal.wt as unknown as Pick<WTerm, "element">, () => undefined);
  if (unwire === "before") detach();
  terminal.down(1);
  if (unwire === "during") detach();
  if (unwire === "never") unmounts.push(detach);
  jest.advanceTimersByTime(LONG_PRESS_MS);
  terminal.pointerMove(1);
  terminal.move(1);
  terminal.up(1);
  terminal.pointerCancel(1);
  return terminal;
}

describe("unwiring takes every listener away (#1901)", () => {
  test("while wired, the hook answers every event of the press, on the element, the document and the window", () => {
    const terminal = pressed("never");
    expect(GESTURE.filter((type) => terminal.handled(type))).toEqual(GESTURE);
  });

  test("unwired before the press, nothing answers any of it", () => {
    const terminal = pressed("before");
    expect(GESTURE.filter((type) => terminal.handled(type))).toEqual([]);
  });

  test("unwired in the middle of a press, the rest of it goes unanswered, the touch it was following included", () => {
    const terminal = pressed("during");
    expect(AFTER_DOWN.filter((type) => terminal.handled(type))).toEqual([]);
  });
});
