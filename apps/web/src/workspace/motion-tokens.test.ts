import { expect, test } from "bun:test";
import { layoutMotion } from "./layout-motion.ts";
import { PINCH_SETTLE } from "../terminal/use-terminal-pinch.ts";
import { BACK_MOTION } from "./phone-back-motion.ts";

const tokens = await Bun.file(new URL("../../../../packages/ui/src/styles/tokens.css", import.meta.url)).text();

const token = (name: string): string => {
  const found = new RegExp(`${name}:\\s*([^;]+);`).exec(tokens)?.[1];
  if (found === undefined) throw new Error(`tokens.css has no ${name}`);
  return found.trim();
};

test("the motion the scripts play is the one tokens.css names", () => {
  expect(layoutMotion((query) => query === "(pointer: coarse)")).toEqual({
    duration: Number.parseInt(token("--duration-split")),
    easing: token("--ease-standard"),
  });
  expect(BACK_MOTION).toEqual({
    duration: Number.parseInt(token("--duration-back")),
    easing: token("--ease-exit"),
  });
  expect(PINCH_SETTLE).toEqual({
    duration: Number.parseInt(token("--duration-settle")),
    easing: token("--ease-standard"),
  });
});

test("the proposal's motion values", () => {
  const values = Object.fromEntries(
    ["press", "color", "push", "back", "sheet-in", "sheet-out", "split", "handle", "card", "settle"].map((name) => [
      name,
      token(`--duration-${name}`),
    ]),
  );
  expect(values).toEqual({
    press: "100ms",
    color: "150ms",
    push: "320ms",
    back: "200ms",
    "sheet-in": "320ms",
    "sheet-out": "200ms",
    split: "240ms",
    handle: "150ms",
    card: "240ms",
    settle: "120ms",
  });
  expect(token("--ease-standard")).toBe("cubic-bezier(0.2, 0, 0, 1)");
  expect(token("--ease-exit")).toBe("cubic-bezier(0.3, 0, 0.8, 0.15)");
  expect(token("--ease-enter")).toBe("cubic-bezier(0.05, 0.7, 0.1, 1)");
});
