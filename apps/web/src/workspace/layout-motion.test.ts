import { expect, test } from "bun:test";
import { layoutMotion } from "./layout-motion.ts";

const media =
  (...matching: string[]) =>
  (query: string): boolean =>
    matching.includes(query);

test("a fine pointer changes splits and moves at once, as herdr-app does", () => {
  expect(layoutMotion(media())).toBeNull();
  expect(layoutMotion(media("(any-hover: hover)"))).toBeNull();
});

test("a touch screen opens and moves panes over 240 ms on the standard curve", () => {
  expect(layoutMotion(media("(pointer: coarse)"))).toEqual({ duration: 240, easing: "cubic-bezier(0.2, 0, 0, 1)" });
});
