import { describe, expect, test } from "bun:test";
import { type BlinkState, cursorBlinks } from "./cursor-blink.ts";

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
