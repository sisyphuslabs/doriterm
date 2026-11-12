import { describe, expect, test } from "bun:test";
import { KEYBOARD_REQUEST_MS, keyboardHeight, keyboardInset, LayoutKeyboard } from "./keyboard-inset.ts";

test.each([
  ["no keyboard", { height: 844, offsetTop: 0, scale: 1 }, 0],
  ["a keyboard over the bottom", { height: 508, offsetTop: 0, scale: 1 }, 336],
  ["a keyboard with the page scrolled up under it", { height: 508, offsetTop: 120, scale: 1 }, 216],
  ["a fractional viewport", { height: 507.6, offsetTop: 0, scale: 1 }, 336],
  ["a pinch zoom, which is not a keyboard", { height: 422, offsetTop: 0, scale: 2 }, 0],
] as const)("the keyboard inset under %s", (_, viewport, inset) => {
  expect(keyboardInset(844, viewport)).toBe(inset);
});

describe("a browser that resizes the page for the keyboard (#244)", () => {
  test("a shrink right after a tap in the terminal is the keyboard; growing back closes it", () => {
    const keyboard = new LayoutKeyboard();
    expect(keyboard.measure(390, 844, 0)).toBe(false);
    keyboard.ask(1000);
    expect(keyboard.measure(390, 508, 1200)).toBe(true);
    expect(keyboard.measure(390, 844, 5000)).toBe(false);
  });

  test("split screen shrinks the page with nobody asking: no keyboard, and it becomes the tallest", () => {
    const keyboard = new LayoutKeyboard();
    keyboard.measure(390, 844, 0);
    keyboard.ask(0);
    expect(keyboard.measure(390, 420, KEYBOARD_REQUEST_MS + 1)).toBe(false);
    // A keyboard in the half screen is measured from the half screen.
    keyboard.ask(10_000);
    expect(keyboard.measure(390, 250, 10_100)).toBe(true);
    expect(keyboard.measure(390, 420, 12_000)).toBe(false);
    // Leaving split screen is no keyboard either way.
    expect(keyboard.measure(390, 844, 13_000)).toBe(false);
  });

  test("a rotation with the keyboard up keeps it up, until the page grows back by a keyboard", () => {
    const keyboard = new LayoutKeyboard();
    keyboard.measure(390, 844, 0);
    keyboard.ask(100);
    expect(keyboard.measure(390, 508, 200)).toBe(true);
    expect(keyboard.measure(844, 190, 5000)).toBe(true);
    expect(keyboard.measure(844, 180, 5100)).toBe(true);
    expect(keyboard.measure(844, 390, 6000)).toBe(false);
    // Back to portrait, keyboard up again: the tallest portrait page is remembered.
    keyboard.ask(7000);
    expect(keyboard.measure(844, 190, 7100)).toBe(true);
    expect(keyboard.measure(390, 508, 8000)).toBe(true);
    expect(keyboard.measure(390, 844, 9000)).toBe(false);
  });
});

test("a pan by the keyboard's height zeroes the inset but not the keyboard's height", () => {
  const panned = { height: 508, offsetTop: 336, scale: 1 };
  expect(keyboardInset(844, panned)).toBe(0);
  expect(keyboardHeight(844, panned)).toBe(336);
  expect(keyboardHeight(844, { height: 844, offsetTop: 0, scale: 1 })).toBe(0);
});

test("a pinch zoom is no keyboard's height either", () => {
  expect(keyboardHeight(844, { height: 422, offsetTop: 0, scale: 2 })).toBe(0);
});
