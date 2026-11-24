import { expect, test } from "bun:test";
import { attachPinchZoom } from "./pinch-zoom.ts";

interface Finger {
  readonly x: number;
  readonly y: number;
}

const touchEvent = (type: string, fingers: readonly Finger[]): Event =>
  Object.assign(new Event(type, { cancelable: true }), {
    touches: fingers.map(({ x, y }) => ({ clientX: x, clientY: y })),
  });

function pinchable(start = 13) {
  const element = new EventTarget();
  const calls: string[] = [];
  let now = 0;
  const detach = attachPinchZoom(element, {
    current: () => start,
    preview: (size) => calls.push(`preview ${size}`),
    release: () => calls.push("release"),
    commit: (size) => calls.push(`commit ${size}`),
    reset: () => calls.push("reset"),
    now: () => now,
  });
  const at = (ms: number) => {
    now = ms;
  };
  const send = (type: string, fingers: readonly Finger[]) => {
    const event = touchEvent(type, fingers);
    element.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { calls, send, at, detach };
}

const pair = (gap: number): Finger[] => [
  { x: 200 - gap / 2, y: 400 },
  { x: 200 + gap / 2, y: 400 },
];

test("spreading two fingers previews each step and commits the size once, on release", () => {
  const { calls, send } = pinchable(13);
  send("touchstart", pair(100));
  expect(send("touchmove", pair(107))).toBe(true);
  send("touchmove", pair(108));
  send("touchmove", pair(113));
  send("touchend", [pair(113)[0] ?? { x: 0, y: 0 }]);
  send("touchend", []);
  expect(calls).toEqual(["preview 13.5", "preview 14", "release", "commit 14"]);
});

test("a pinch that ends where it started commits nothing", () => {
  const { calls, send } = pinchable(13);
  send("touchstart", pair(100));
  send("touchmove", pair(107));
  send("touchmove", pair(100));
  send("touchend", []);
  expect(calls).toEqual(["preview 13.5", "preview 13", "release"]);
});

test("one finger is left to the browser: no pinch, nothing prevented", () => {
  const { calls, send } = pinchable();
  send("touchstart", [{ x: 10, y: 10 }]);
  expect(send("touchmove", [{ x: 10, y: 60 }])).toBe(false);
  send("touchend", []);
  expect(calls).toEqual([]);
});

test("two quick two-finger taps reset the size", () => {
  const { calls, send, at } = pinchable();
  at(0);
  send("touchstart", pair(100));
  at(60);
  send("touchend", []);
  at(180);
  send("touchstart", pair(100));
  at(230);
  send("touchend", []);
  expect(calls).toEqual(["release", "release", "reset"]);
});

test("detaching stops listening", () => {
  const { calls, send, detach } = pinchable();
  detach();
  send("touchstart", pair(100));
  send("touchmove", pair(130));
  send("touchend", []);
  expect(calls).toEqual([]);
});
