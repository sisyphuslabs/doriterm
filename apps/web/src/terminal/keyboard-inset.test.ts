import { expect, test } from "bun:test";
import { keyboardInset } from "./keyboard-inset.ts";

test.each([
  ["no keyboard", { height: 844, offsetTop: 0, scale: 1 }, 0],
  ["a keyboard over the bottom", { height: 508, offsetTop: 0, scale: 1 }, 336],
  ["a keyboard with the page scrolled up under it", { height: 508, offsetTop: 120, scale: 1 }, 216],
  ["a fractional viewport", { height: 507.6, offsetTop: 0, scale: 1 }, 336],
  ["a pinch zoom, which is not a keyboard", { height: 422, offsetTop: 0, scale: 2 }, 0],
] as const)("the keyboard inset under %s", (_, viewport, inset) => {
  expect(keyboardInset(844, viewport)).toBe(inset);
});
