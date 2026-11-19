import { describe, expect, test } from "bun:test";
import {
  BLINK_PHASE_MS,
  type BlinkState,
  CursorBlink,
  type CursorPhase,
  type CursorState,
  cursorBlinks,
  cursorKind,
} from "./cursor-blink.ts";
import type { FrameTimer, Timer } from "./output-pacer.ts";

const idle: BlinkState = {
  focused: true,
  blinkAsked: false,
  steadyAsked: false,
  programBlinks: true,
  visible: true,
  hidden: false,
};

describe("cursorBlinks: wterm's rule for a blinking cursor, and only while the window can be seen", () => {
  test("a focused terminal whose program asks for a blinking cursor blinks", () => {
    expect(cursorBlinks(idle)).toBe(true);
  });

  test.each([
    ["not focused", { focused: false }],
    ["the window is hidden", { visible: false }],
    ["the config asks for a steady cursor", { steadyAsked: true }],
    ["the program's cursor is steady", { programBlinks: false }],
    ["a composition or a prediction hides the cursor", { hidden: true }],
  ])("%s: no blink", (_, change) => {
    expect(cursorBlinks({ ...idle, ...change })).toBe(false);
  });

  test("the config's blink wins over a program's steady cursor, but never blinks a hidden window", () => {
    expect(cursorBlinks({ ...idle, blinkAsked: true, programBlinks: false })).toBe(true);
    expect(cursorBlinks({ ...idle, blinkAsked: true, visible: false })).toBe(false);
  });
});

describe("cursorKind: which of wterm's and the config's blink animations the cursor ran", () => {
  test.each([
    ["block", false, "block"],
    [undefined, false, "block"],
    ["block", true, "hollow"],
    [undefined, true, "hollow"],
    ["bar", false, "line"],
    ["underline", false, "line"],
    // The config's hollow rule leaves a bar and an underline to wterm's line blink.
    ["bar", true, "line"],
    ["underline", true, "line"],
  ] as const)("shape %p, hollow %p: %p", (shape, hollow, kind) => {
    expect(cursorKind(shape, hollow)).toBe(kind);
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

/** Animation frames that come only when the test runs them: each run takes the frames booked so far. */
function manualFrames() {
  let due: (() => void)[] = [];
  const frame: FrameTimer = (run) => {
    due.push(run);
    return () => {
      due = due.filter((entry) => entry !== run);
    };
  };
  const run = (): void => {
    const now = due;
    due = [];
    for (const entry of now) entry();
  };
  return { frame, run, booked: () => due.length };
}

/**
 * A blink over a terminal whose state the test sets in `state`, the way the DOM would read it; `phase()` is what
 * data-cursor-phase says now (null: not blinking), `watching` whether the grid is watched for a rebuilt cursor.
 */
function blink(initial: Partial<CursorState> = {}) {
  const timers = manualTimers();
  const frames = manualFrames();
  const state: { current: CursorState } = { current: { ...idle, kind: "block", ...initial } };
  let phase: CursorPhase | null = null;
  const shown: (CursorPhase | null)[] = [];
  let watching = false;
  const cursor = new CursorBlink(
    () => state.current,
    (next) => {
      phase = next;
      shown.push(next);
    },
    (on) => {
      watching = on;
    },
    timers.timer,
    frames.frame,
  );
  const set = (change: Partial<CursorState>): void => {
    state.current = { ...state.current, ...change };
  };
  return { cursor, timers, frames, set, phase: () => phase, shown, watching: () => watching };
}

describe("CursorBlink: on half a second, off half a second, started over whenever the cursor is drawn anew", () => {
  test("a cursor that does not blink books no timer and is never marked", () => {
    const { cursor, timers, shown, watching } = blink({ focused: false });
    cursor.decide();
    expect(timers.booked()).toBe(0);
    timers.advance(10 * BLINK_PHASE_MS);
    expect(shown).toEqual([]);
    expect(cursor.blinking).toBe(false);
    expect(watching()).toBe(false);
  });

  test("a blink starts on and alternates every 500 ms, with one timer booked at a time", () => {
    const { cursor, timers, phase, watching } = blink();
    cursor.decide();
    expect(phase()).toBe("on");
    expect(watching()).toBe(true);
    expect(timers.booked()).toBe(1);
    timers.advance(BLINK_PHASE_MS - 1);
    expect(phase()).toBe("on");
    timers.advance(1);
    expect(phase()).toBe("off");
    timers.advance(BLINK_PHASE_MS);
    expect(phase()).toBe("on");
    timers.advance(BLINK_PHASE_MS);
    expect(phase()).toBe("off");
    expect(timers.booked()).toBe(1);
  });

  test("a restart in the off phase draws the cursor on at once and gives it a whole on phase", () => {
    const { cursor, timers, phase } = blink();
    cursor.decide();
    timers.advance(BLINK_PHASE_MS + 200);
    expect(phase()).toBe("off");
    cursor.restart();
    expect(phase()).toBe("on");
    expect(timers.booked()).toBe(1);
    timers.advance(BLINK_PHASE_MS - 1);
    expect(phase()).toBe("on");
    timers.advance(1);
    expect(phase()).toBe("off");
  });

  test("a restart while not blinking marks nothing and books nothing", () => {
    const { cursor, timers, shown } = blink({ focused: false });
    cursor.decide();
    cursor.restart();
    expect(shown).toEqual([]);
    expect(timers.booked()).toBe(0);
  });

  test("a decide that changes nothing leaves the phase where it is", () => {
    const { cursor, timers, phase } = blink();
    cursor.decide();
    timers.advance(BLINK_PHASE_MS);
    cursor.decide();
    expect(phase()).toBe("off");
  });

  test("a cursor that stops blinking is unmarked, its timer cancelled and the grid no longer watched", () => {
    const { cursor, timers, set, phase, watching } = blink();
    cursor.decide();
    timers.advance(BLINK_PHASE_MS);
    expect(phase()).toBe("off");
    set({ focused: false });
    cursor.decide();
    expect(phase()).toBe(null);
    expect(timers.booked()).toBe(0);
    expect(cursor.blinking).toBe(false);
    expect(watching()).toBe(false);
    timers.advance(10 * BLINK_PHASE_MS);
    expect(phase()).toBe(null);
  });

  test("stop ends a blink for good", () => {
    const { cursor, timers, phase, watching } = blink();
    cursor.decide();
    cursor.stop();
    expect(phase()).toBe(null);
    expect(timers.booked()).toBe(0);
    expect(watching()).toBe(false);
  });
});

// wterm's animation started over whenever its name changed: block (cursor-blink) to a bar or underline
// (cursor-line-blink) by DECSCUSR, or the config's hollow class (doriface-hollow-blink) coming or going.
describe("CursorBlink: a change of animation shows the cursor on at once, as a renamed animation did", () => {
  test.each([
    ["block", "line"],
    ["line", "block"],
    ["block", "hollow"],
    ["hollow", "block"],
    ["hollow", "line"],
  ] as const)("%p to %p in the off phase", (from, to) => {
    const { cursor, timers, set, phase } = blink({ kind: from });
    cursor.decide();
    timers.advance(BLINK_PHASE_MS + 100);
    expect(phase()).toBe("off");
    set({ kind: to });
    cursor.decide();
    expect(phase()).toBe("on");
    expect(timers.booked()).toBe(1);
    timers.advance(BLINK_PHASE_MS - 1);
    expect(phase()).toBe("on");
    timers.advance(1);
    expect(phase()).toBe("off");
  });

  test("a bar becoming an underline keeps the animation and its phase", () => {
    const { cursor, timers, set, phase } = blink({ kind: cursorKind("bar", false) });
    cursor.decide();
    timers.advance(BLINK_PHASE_MS + 100);
    set({ kind: cursorKind("underline", false) });
    cursor.decide();
    expect(phase()).toBe("off");
  });

  test("a change of kind while not blinking starts nothing", () => {
    const { cursor, timers, set, shown } = blink({ focused: false });
    cursor.decide();
    set({ kind: "line" });
    cursor.decide();
    expect(shown).toEqual([]);
    expect(timers.booked()).toBe(0);
  });
});

// The events that end a press can go missing (a press that opens a context menu never sees its release), so each
// phase asks again: whatever was missed is put right within one phase, and nothing is asked while nothing blinks.
describe("CursorBlink: each phase takes the answer again, so a missed event heals within one phase", () => {
  test("a terminal that stopped blinking unnoticed is unmarked at the next phase, and nothing more is booked", () => {
    const { cursor, timers, set, phase, watching } = blink();
    cursor.decide();
    set({ focused: false });
    timers.advance(BLINK_PHASE_MS);
    expect(phase()).toBe(null);
    expect(cursor.blinking).toBe(false);
    expect(watching()).toBe(false);
    expect(timers.booked()).toBe(0);
  });

  test("a change of kind that went unnoticed starts the phase over at the next phase", () => {
    const { cursor, timers, set, phase } = blink();
    cursor.decide();
    set({ kind: "line" });
    timers.advance(BLINK_PHASE_MS);
    expect(phase()).toBe("on");
    timers.advance(BLINK_PHASE_MS);
    expect(phase()).toBe("off");
  });

  test("the state is read once a phase while blinking, and never while not", () => {
    const timers = manualTimers();
    let reads = 0;
    let state: CursorState = { ...idle, kind: "block" };
    const cursor = new CursorBlink(
      () => {
        reads++;
        return state;
      },
      () => {},
      () => {},
      timers.timer,
    );
    cursor.decide();
    expect(reads).toBe(1);
    timers.advance(4 * BLINK_PHASE_MS);
    expect(reads).toBe(5);
    state = { ...state, focused: false };
    cursor.decide();
    const settled = reads;
    timers.advance(10 * BLINK_PHASE_MS);
    expect(reads).toBe(settled);
  });
});

// The hide rule (styles.css) stopped wterm's animation while a composition or a prediction hid the cursor, and its
// removal started a fresh one: the cursor showed on at once, for a whole on phase.
describe("CursorBlink: a cursor hidden by a composition or a prediction does not blink, and shows on when shown", () => {
  test("a hidden cursor books no timer, is never marked and the grid is not watched", () => {
    const { cursor, timers, shown, watching } = blink({ hidden: true });
    cursor.decide();
    expect(timers.booked()).toBe(0);
    timers.advance(10 * BLINK_PHASE_MS);
    expect(shown).toEqual([]);
    expect(cursor.blinking).toBe(false);
    expect(watching()).toBe(false);
  });

  test("hidden in the off phase, then shown: drawn on at once with a whole on phase", () => {
    const { cursor, timers, set, phase, watching } = blink();
    cursor.decide();
    timers.advance(BLINK_PHASE_MS + 200);
    expect(phase()).toBe("off");
    set({ hidden: true });
    cursor.decide();
    expect(phase()).toBe(null);
    expect(timers.booked()).toBe(0);
    expect(watching()).toBe(false);
    timers.advance(BLINK_PHASE_MS + 300);
    set({ hidden: false });
    cursor.decide();
    expect(phase()).toBe("on");
    expect(timers.booked()).toBe(1);
    timers.advance(BLINK_PHASE_MS - 1);
    expect(phase()).toBe("on");
    timers.advance(1);
    expect(phase()).toBe("off");
  });
});

// On touch, Chromium sets :active after pointerdown (at the gesture's show-press), with no event of its own; wterm's
// CSS blinked a held, unfocused terminal from then on. So a held press takes the state again on each frame until the
// cursor blinks or the press ends, and only then.
describe("CursorBlink: a held press takes the state again each frame until the cursor blinks", () => {
  test("a press that is not :active yet blinks on the first frame after it is", () => {
    const { cursor, timers, frames, set, phase } = blink({ focused: false });
    cursor.press();
    expect(phase()).toBe(null);
    expect(frames.booked()).toBe(1);
    frames.run();
    expect(phase()).toBe(null);
    expect(frames.booked()).toBe(1);
    set({ focused: true });
    frames.run();
    expect(phase()).toBe("on");
    expect(frames.booked()).toBe(0);
    expect(timers.booked()).toBe(1);
  });

  test("a press on a cursor that blinks already books no frame", () => {
    const { cursor, frames, phase } = blink();
    cursor.press();
    expect(phase()).toBe("on");
    expect(frames.booked()).toBe(0);
  });

  test("a release ends the frames, and nothing is read after it", () => {
    const timers = manualTimers();
    const frames = manualFrames();
    let reads = 0;
    const cursor = new CursorBlink(
      () => {
        reads++;
        return { ...idle, focused: false, kind: "block" };
      },
      () => {},
      () => {},
      timers.timer,
      frames.frame,
    );
    cursor.press();
    frames.run();
    frames.run();
    expect(reads).toBe(3);
    cursor.release();
    expect(frames.booked()).toBe(0);
    const released = reads;
    frames.run();
    timers.advance(10 * BLINK_PHASE_MS);
    expect(reads).toBe(released);
    expect(cursor.blinking).toBe(false);
  });

  // A press can only bring :active, so a cursor that would not blink even focused is not followed: a click or a
  // drag in a terminal whose cursor is steady, hidden, or in a hidden window costs one read and no frame.
  test.each<[string, Partial<CursorState>]>([
    ["the program's cursor is steady", { programBlinks: false }],
    ["the config asks for a steady cursor", { steadyAsked: true }],
    ["a composition or a prediction hides the cursor", { hidden: true }],
    ["the window is hidden", { visible: false }],
  ])("a press where %s books no frame", (_, state) => {
    for (const focused of [true, false]) {
      const { cursor, frames, phase } = blink({ ...state, focused });
      cursor.press();
      expect(frames.booked()).toBe(0);
      expect(phase()).toBe(null);
    }
  });

  // The press is remembered until its release: a cursor asked to blink while it is held (the program's DECSCUSR, a
  // composition ending) is followed from then on, as the CSS would have blinked it once :active came.
  test("a held press on a steady cursor is followed once the cursor is asked to blink", () => {
    const { cursor, frames, set, phase } = blink({ focused: false, programBlinks: false });
    cursor.press();
    expect(frames.booked()).toBe(0);
    set({ programBlinks: true });
    cursor.decide();
    expect(frames.booked()).toBe(1);
    set({ focused: true });
    frames.run();
    expect(phase()).toBe("on");
    expect(frames.booked()).toBe(0);
  });

  test("after the release a change of state books no frame", () => {
    const { cursor, frames, set } = blink({ focused: false, programBlinks: false });
    cursor.press();
    cursor.release();
    set({ programBlinks: true });
    cursor.decide();
    expect(frames.booked()).toBe(0);
  });

  test("stop ends a held press's frames too", () => {
    const { cursor, frames } = blink({ focused: false });
    cursor.press();
    cursor.stop();
    expect(frames.booked()).toBe(0);
  });
});
