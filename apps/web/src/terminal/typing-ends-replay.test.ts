import { expect, test } from "bun:test";
import { typingEndsReplay } from "./typing-ends-replay.ts";

function watched() {
  const target = new EventTarget();
  let typed = 0;
  const stop = typingEndsReplay(target, { typed: () => void (typed += 1) });
  return { target, typed: () => typed, stop };
}

test("a key, text a soft keyboard or an IME puts in, and a paste each let the replay go (#2794)", () => {
  const { target, typed } = watched();
  for (const type of ["keydown", "beforeinput", "paste"]) target.dispatchEvent(new Event(type));
  expect(typed()).toBe(3);
});

test("a touch, a click, the wheel and focus do not: only typing lets the replay go", () => {
  const { target, typed } = watched();
  for (const type of ["touchstart", "pointerdown", "wheel", "focusin", "input"]) target.dispatchEvent(new Event(type));
  expect(typed()).toBe(0);
});

test("once stopped, typing no longer reaches the output", () => {
  const { target, typed, stop } = watched();
  stop();
  target.dispatchEvent(new Event("keydown"));
  expect(typed()).toBe(0);
});
