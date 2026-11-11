import { afterEach, expect, test } from "bun:test";
import type { WTerm } from "@wterm/react";
import { attachTouchWheel } from "./touch-wheel.ts";

/** The grid the fake terminal shows: 10 rows of 30 cells, its first row's top-left corner at (5, 100). */
const LEFT = 5;
const TOP = 100;
const CELL_W = 10;
const ROW_H = 20;
const ROWS = 10;
const COLS = 30;

/** Bun has no WheelEvent: this carries the fields the hook sets, as the browser's does. */
class FakeWheelEvent extends Event {
  static readonly DOM_DELTA_PIXEL = 0;
  readonly deltaY: number;
  readonly clientX: number;
  readonly clientY: number;
  constructor(type: string, init: WheelEventInit) {
    super(type, init);
    this.deltaY = init.deltaY ?? 0;
    this.clientX = init.clientX ?? 0;
    this.clientY = init.clientY ?? 0;
  }
}

interface Point {
  readonly x: number;
  readonly y: number;
}

interface SwipeTerminal {
  /** Every wheel the hook handed the renderer, in order. */
  readonly wheels: FakeWheelEvent[];
  /** One finger lands, moves through `path` and lifts; returns whether each move was cancelled. */
  swipe(from: Point, ...path: Point[]): boolean[];
  /**
   * The same, landing on a cell the program then redraws away: the browser sends the touch's moves and lift to that
   * cell alone, which is no longer in the terminal to pass them on (#2054).
   */
  swipeOnRedrawnCell(from: Point, ...path: Point[]): boolean[];
  /**
   * Two fingers land, each on its own cell, and the second lifts: the first is left down and drags through `path`. The
   * browser sends each touch's moves and lift to the cell that finger landed on. Returns whether each move was cancelled.
   */
  pinchThenDrag(first: Point, second: Point, ...path: Point[]): boolean[];
}

const unmounts: (() => void)[] = [];
const previousWheel = globalThis.WheelEvent;
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
  if (previousWheel === undefined) Reflect.deleteProperty(globalThis, "WheelEvent");
  else Object.assign(globalThis, { WheelEvent: previousWheel });
});

/** A touch event as the hook reads it: cancelable, with the fingers down. */
const touchEvent = (type: string, fingers: readonly Point[]): Event =>
  Object.assign(new Event(type, { cancelable: true }), {
    touches: fingers.map(({ x, y }) => ({ clientX: x, clientY: y })),
  });

/** A touch event sent to the cell a finger landed on, as the browser sends that touch's moves and lift. */
const sendToCell = (cell: EventTarget, type: string, fingers: readonly Point[]): Event => {
  const event = touchEvent(type, fingers);
  cell.dispatchEvent(event);
  return event;
};

/** A terminal wired as the terminal view wires it through useTouchWheel, on the alternate screen unless `alt` is false. */
function wiredTerminal(alt = true): SwipeTerminal {
  Object.assign(globalThis, { WheelEvent: FakeWheelEvent });
  const row = {
    getBoundingClientRect: () => ({ left: LEFT, top: TOP, height: ROW_H, width: COLS * CELL_W }),
  };
  const element = Object.assign(new EventTarget(), {
    querySelector: (selector: string) => (selector === ".term-row:not(.term-scrollback-row)" ? row : null),
    style: { getPropertyValue: (name: string) => (name === "--term-cell-width" ? `${CELL_W}px` : "") },
  });
  const bridge = { usingAltScreen: () => alt, getRows: () => ROWS, getCols: () => COLS };
  const wheels: FakeWheelEvent[] = [];
  element.addEventListener("wheel", (event) => wheels.push(event as FakeWheelEvent));
  unmounts.push(attachTouchWheel({ element, bridge } as unknown as Pick<WTerm, "element" | "bridge">));
  /** A finger lands on `cell` inside the terminal: the terminal sees the touchstart, with that cell its target. */
  const landed = (fingers: readonly Point[], cell: EventTarget): void => {
    element.dispatchEvent(Object.defineProperty(touchEvent("touchstart", fingers), "target", { value: cell }));
  };
  const touch = (type: string, fingers: readonly Point[]): Event => {
    const event = touchEvent(type, fingers);
    element.dispatchEvent(event);
    return event;
  };
  return {
    wheels,
    swipe(from, ...path) {
      touch("touchstart", [from]);
      const cancelled = path.map((at) => touch("touchmove", [at]).defaultPrevented);
      touch("touchend", []);
      return cancelled;
    },
    pinchThenDrag(first, second, ...path) {
      const firstCell = new EventTarget();
      const secondCell = new EventTarget();
      landed([first], firstCell);
      landed([first, second], secondCell);
      // The second finger lifts: its touchend goes to its own cell and lists the finger still down.
      sendToCell(secondCell, "touchend", [first]);
      const cancelled = path.map((at) => sendToCell(firstCell, "touchmove", [at]).defaultPrevented);
      sendToCell(firstCell, "touchend", []);
      return cancelled;
    },
    swipeOnRedrawnCell(from, ...path) {
      const cell = new EventTarget();
      // The cell was in the terminal when the finger landed: the terminal saw the touchstart, with the cell its target.
      element.dispatchEvent(Object.defineProperty(touchEvent("touchstart", [from]), "target", { value: cell }));
      const onCell = (type: string, fingers: readonly Point[]): Event => {
        const event = touchEvent(type, fingers);
        cell.dispatchEvent(event);
        return event;
      };
      const cancelled = path.map((at) => onCell("touchmove", [at]).defaultPrevented);
      onCell("touchend", []);
      return cancelled;
    },
  };
}

test("a finger moving down turns the wheel up, one notch for each row it travels (#1996)", () => {
  const terminal = wiredTerminal();
  const cancelled = terminal.swipe({ x: 50, y: 130 }, { x: 50, y: 130 + 2.5 * ROW_H }, { x: 50, y: 130 + 5 * ROW_H });
  expect(terminal.wheels.map((wheel) => wheel.deltaY)).toEqual(Array.from({ length: 5 }, () => -ROW_H));
  expect(cancelled).toEqual([true, true]);
});

test("a finger whose cell the program redraws away keeps turning the wheel, and the page never gets its moves (#2054)", () => {
  const terminal = wiredTerminal();
  const cancelled = terminal.swipeOnRedrawnCell(
    { x: 50, y: 130 },
    { x: 50, y: 130 + 2 * ROW_H },
    { x: 50, y: 130 + 4 * ROW_H },
  );
  expect(terminal.wheels.map((wheel) => wheel.deltaY)).toEqual(Array.from({ length: 4 }, () => -ROW_H));
  expect(cancelled).toEqual([true, true]);
  // Its lift ended the swipe: a later touch on the terminal itself is followed there.
  expect(terminal.swipe({ x: 50, y: 250 }, { x: 50, y: 250 - ROW_H })).toEqual([true]);
  expect(terminal.wheels).toHaveLength(5);
});

test("a finger moving up turns the wheel down", () => {
  const terminal = wiredTerminal();
  terminal.swipe({ x: 50, y: 250 }, { x: 50, y: 250 - 3 * ROW_H });
  expect(terminal.wheels.map((wheel) => wheel.deltaY)).toEqual([ROW_H, ROW_H, ROW_H]);
});

test("every notch is reported in the cell the swipe began on, even once the finger leaves the grid", () => {
  const terminal = wiredTerminal();
  // Begins in column 5 of row 1, then runs past the grid's right and bottom edges.
  terminal.swipe({ x: 57, y: 135 }, { x: 200, y: 235 }, { x: 400, y: 435 });
  expect(terminal.wheels).toHaveLength(15);
  const at = new Set(terminal.wheels.map((wheel) => `${wheel.clientX},${wheel.clientY}`));
  expect([...at]).toEqual([`${LEFT + 5.5 * CELL_W},${TOP + 1.5 * ROW_H}`]);
});

test("a swipe that begins past the grid's edge is reported in the nearest cell", () => {
  const terminal = wiredTerminal();
  terminal.swipe({ x: 900, y: 900 }, { x: 900, y: 900 - 2 * ROW_H });
  const at = new Set(terminal.wheels.map((wheel) => `${wheel.clientX},${wheel.clientY}`));
  expect([...at]).toEqual([`${LEFT + (COLS - 0.5) * CELL_W},${TOP + (ROWS - 0.5) * ROW_H}`]);
});

test("on the normal screen a swipe turns no wheel and is left to the browser's pan", () => {
  const terminal = wiredTerminal(false);
  const cancelled = terminal.swipe({ x: 50, y: 130 }, { x: 50, y: 130 + 5 * ROW_H });
  expect(terminal.wheels).toHaveLength(0);
  expect(cancelled).toEqual([false]);
});

test("after a pinch, the finger left down starts a swipe of its own, and the page never gets its moves (#2031)", () => {
  const terminal = wiredTerminal();
  const first = { x: 50, y: 130 };
  const cancelled = terminal.pinchThenDrag(
    first,
    { x: 90, y: 200 },
    { x: 50, y: 130 + ROW_H },
    { x: 50, y: 130 + 3 * ROW_H },
  );
  expect(cancelled).toEqual([true, true]);
  // Measured from where that finger was when the pinch ended: three rows down turns the wheel up three notches.
  expect(terminal.wheels.map((wheel) => wheel.deltaY)).toEqual(Array.from({ length: 3 }, () => -ROW_H));
});
