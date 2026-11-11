import { afterEach, expect, test } from "bun:test";
import { trackHeldPress, whenPressEnds } from "./use-quiet-keyboard.ts";

const aborts: AbortController[] = [];
afterEach(() => {
  for (const abort of aborts.splice(0)) abort.abort();
});

/** A pointer event as the browser dispatches it, with only what the tracker reads. */
const pointer = (type: string, pointerId: number, pointerType: string, isPrimary = true, buttons = 1): Event =>
  Object.assign(new Event(type), { pointerId, pointerType, isPrimary, buttons });

/** A phone terminal's scope and its window, with a pointer's down, up and cancel as the browser dispatches them. */
function pressed() {
  const scope = new EventTarget();
  const view = new EventTarget();
  const abort = new AbortController();
  aborts.push(abort);
  const held = trackHeldPress(scope, view, abort.signal);
  return {
    held,
    down: (id: number, kind: string, isPrimary = true) =>
      scope.dispatchEvent(pointer("pointerdown", id, kind, isPrimary)),
    up: (id: number, kind: string) => view.dispatchEvent(pointer("pointerup", id, kind)),
    cancel: (id: number, kind: string) => view.dispatchEvent(pointer("pointercancel", id, kind)),
    /** The pointer moves over the page with no button down: it is not pressing any more. */
    hover: (id: number, kind: string) => view.dispatchEvent(pointer("pointermove", id, kind, true, 0)),
    /** The page loses the focus (another app, a tab switch, a context menu): a lift then is never seen. */
    blur: () => view.dispatchEvent(new Event("blur")),
    view,
  };
}

test("a press is held from its pointerdown until its own lift", () => {
  const terminal = pressed();
  expect(terminal.held()).toBeNull();
  terminal.down(1, "mouse");
  expect(terminal.held()).toBe(1);
  terminal.up(1, "mouse");
  expect(terminal.held()).toBeNull();
});

test("a second finger, which is not primary, neither takes the press over nor ends it (#2093)", () => {
  const terminal = pressed();
  terminal.down(7, "touch");
  terminal.down(8, "touch", false);
  terminal.up(8, "touch");
  expect(terminal.held()).toBe(7);
});

test("a pointer of another type landing and lifting while a press is held leaves that press held (#2138)", () => {
  const terminal = pressed();
  // A touch is primary for its own type even with the mouse button down: it must not take the mouse's press over.
  terminal.down(1, "mouse");
  terminal.down(9, "touch");
  expect(terminal.held()).toBe(1);
  terminal.up(9, "touch");
  expect(terminal.held()).toBe(1);
  terminal.up(1, "mouse");
  expect(terminal.held()).toBeNull();
});

test("a press whose lift the page never saw is replaced by the next press of the same pointer type (#2138)", () => {
  const terminal = pressed();
  terminal.down(1, "mouse");
  // The button came up outside anything that reported it; the next press of that mouse is a press of its own.
  terminal.down(1, "mouse");
  terminal.up(1, "mouse");
  expect(terminal.held()).toBeNull();
  terminal.down(3, "touch");
  terminal.down(4, "touch");
  expect(terminal.held()).toBe(4);
  terminal.cancel(4, "touch");
  expect(terminal.held()).toBeNull();
});

test("a mouse press whose lift the page never saw ends once that mouse moves with no button down (#2160)", () => {
  const terminal = pressed();
  terminal.down(1, "mouse");
  terminal.hover(1, "mouse");
  expect(terminal.held()).toBeNull();
  // A touch after it is a press of its own, not one ignored behind a press that is long over.
  terminal.down(9, "touch");
  expect(terminal.held()).toBe(9);
});

test("a press ends when the page loses the focus, so a lift lost to another app never leaves it held (#2160)", () => {
  const terminal = pressed();
  terminal.down(1, "mouse");
  terminal.blur();
  expect(terminal.held()).toBeNull();
});

test("the keyboard waits for the press the tracker holds now, not the one it held when it went down (#2160)", () => {
  const terminal = pressed();
  terminal.down(1, "touch");
  let quieted = 0;
  const abort = new AbortController();
  aborts.push(abort);
  whenPressEnds(terminal.view, terminal.held, () => quieted++, abort.signal);
  expect(quieted).toBe(0);
  // That touch's lift was lost; the next touch is the press now, and its lift is the one that ends the wait.
  terminal.down(2, "touch");
  terminal.up(2, "touch");
  expect(terminal.held()).toBeNull();
  expect(quieted).toBe(1);
});

test("with no press held the keyboard quiets at once, and only once", () => {
  const terminal = pressed();
  let quieted = 0;
  const abort = new AbortController();
  aborts.push(abort);
  whenPressEnds(terminal.view, terminal.held, () => quieted++, abort.signal);
  terminal.down(1, "touch");
  terminal.up(1, "touch");
  expect(quieted).toBe(1);
});
