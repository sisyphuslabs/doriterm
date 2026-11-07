import { afterEach, expect, test } from "bun:test";
import { holdAtEnd } from "./hold-view-at-end.ts";

const frames: (() => void)[] = [];
const requestAnimationFrame = (run: () => void): number => frames.push(run);
Reflect.set(globalThis, "requestAnimationFrame", requestAnimationFrame);
const runFrame = (): void => frames.shift()?.();

afterEach(() => {
  frames.length = 0;
});

const scroller = (scrollTop: number, scrollHeight: number, clientHeight = 100) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

test("a reader at the end is held there while the replay streams", () => {
  const element = scroller(400, 500);
  holdAtEnd(element, () => true);
  element.scrollHeight = 900;
  runFrame();
  expect(element.scrollTop).toBe(900);
});

test("a reader at the end is held again after the reset collapses the scroller", () => {
  const element = scroller(400, 500);
  holdAtEnd(element, () => true);
  // The reset's own render runs before the hold's first frame, emptying the scroller: the height and the position drop.
  element.scrollHeight = 100;
  element.scrollTop = 0;
  runFrame();
  // The replay's rows then grow it again.
  element.scrollHeight = 900;
  runFrame();
  expect(element.scrollTop).toBe(900);
});

test("a reader who had scrolled up is left where they are", () => {
  const element = scroller(100, 500);
  holdAtEnd(element, () => true);
  element.scrollHeight = 900;
  runFrame();
  expect(element.scrollTop).toBe(100);
});

test("the hold lets go when the reader scrolls away", () => {
  const element = scroller(400, 500);
  holdAtEnd(element, () => true);
  runFrame();
  element.scrollTop = 250;
  element.scrollHeight = 1200;
  runFrame();
  expect(element.scrollTop).toBe(250);
});

test("the hold stops when the replay does", () => {
  const element = scroller(400, 500);
  let streaming = true;
  holdAtEnd(element, () => streaming);
  runFrame();
  streaming = false;
  runFrame();
  const queued = frames.length;
  element.scrollHeight = 1500;
  element.scrollTop = 0;
  runFrame();
  expect(frames.length).toBe(queued);
  expect(element.scrollTop).toBe(0);
});
