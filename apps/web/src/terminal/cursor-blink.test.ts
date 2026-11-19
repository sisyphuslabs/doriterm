import { describe, expect, test } from "bun:test";
import { BLINK_PHASE_MS, BlinkPhase, type BlinkState, cursorBlinks } from "./cursor-blink.ts";
import type { Timer } from "./output-pacer.ts";

const idle: BlinkState = { focused: true, blinkAsked: false, steadyAsked: false, programBlinks: true, visible: true };

describe("cursorBlinks: wterm's rule for a blinking cursor, and only while the window can be seen", () => {
  test("a focused terminal whose program asks for a blinking cursor blinks", () => {
    expect(cursorBlinks(idle)).toBe(true);
  });

  test.each([
    ["not focused", { focused: false }],
    ["the window is hidden", { visible: false }],
    ["the config asks for a steady cursor", { steadyAsked: true }],
    ["the program's cursor is steady", { programBlinks: false }],
  ])("%s: no blink", (_, change) => {
    expect(cursorBlinks({ ...idle, ...change })).toBe(false);
  });

  test("the config's blink wins over a program's steady cursor, but never blinks a hidden window", () => {
    expect(cursorBlinks({ ...idle, blinkAsked: true, programBlinks: false })).toBe(true);
    expect(cursorBlinks({ ...idle, blinkAsked: true, visible: false })).toBe(false);
  });
});

/** Timers on a clock that moves only when the test advances it; due timers run in order of when they are due. */
function manualTimers() {
  let now = 0;
  const due: { at: number; run: () => void }[] = [];
  const timer: Timer = (run, ms) => {
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
  return { timer, advance, booked: () => due.length };
}

/** A phase whose drawn state the test reads: `off()` is what data-cursor-off says now. */
function phase() {
  const timers = manualTimers();
  let off = false;
  const shown: boolean[] = [];
  const blink = new BlinkPhase((next) => {
    off = next;
    shown.push(next);
  }, timers.timer);
  return { blink, timers, off: () => off, shown };
}

describe("BlinkPhase: on half a second, off half a second, started over whenever the cursor is drawn anew", () => {
  test("a cursor that does not blink books no timer and is never drawn off", () => {
    const { blink, timers, shown } = phase();
    expect(timers.booked()).toBe(0);
    timers.advance(10 * BLINK_PHASE_MS);
    expect(shown).toEqual([]);
    expect(blink.blinking).toBe(false);
  });

  test("a blink starts on and alternates every 500 ms, with one timer booked at a time", () => {
    const { blink, timers, off } = phase();
    blink.restart();
    expect(off()).toBe(false);
    expect(timers.booked()).toBe(1);
    timers.advance(BLINK_PHASE_MS - 1);
    expect(off()).toBe(false);
    timers.advance(1);
    expect(off()).toBe(true);
    timers.advance(BLINK_PHASE_MS);
    expect(off()).toBe(false);
    timers.advance(BLINK_PHASE_MS);
    expect(off()).toBe(true);
    expect(timers.booked()).toBe(1);
  });

  test("a restart in the off phase draws the cursor on at once and gives it a whole on phase", () => {
    const { blink, timers, off } = phase();
    blink.restart();
    timers.advance(BLINK_PHASE_MS + 200);
    expect(off()).toBe(true);
    blink.restart();
    expect(off()).toBe(false);
    expect(timers.booked()).toBe(1);
    timers.advance(BLINK_PHASE_MS - 1);
    expect(off()).toBe(false);
    timers.advance(1);
    expect(off()).toBe(true);
  });

  test("stop cancels the timer and clears the off phase", () => {
    const { blink, timers, off } = phase();
    blink.restart();
    timers.advance(BLINK_PHASE_MS);
    expect(off()).toBe(true);
    blink.stop();
    expect(off()).toBe(false);
    expect(timers.booked()).toBe(0);
    expect(blink.blinking).toBe(false);
    timers.advance(10 * BLINK_PHASE_MS);
    expect(off()).toBe(false);
  });
});
