import { expect, test } from "bun:test";
import { reattachClear } from "./reattach-clear.ts";

const SCREEN_ONLY = "\u001b[H\u001b[J";
const PRIMARY_TOO = "\u001b[?1049l\u001b[H\u001b[J";

test("a core that draws the primary screen again has the view clear the primary screen too (#2514)", () => {
  expect(reattachClear("0.1.21")).toBe(PRIMARY_TOO);
  expect(reattachClear("hc 0.1.21")).toBe(PRIMARY_TOO);
  expect(reattachClear("0.2.0")).toBe(PRIMARY_TOO);
});

test("an older core, or one whose version is not known, keeps the primary screen its repaint scrolls into history (#1999)", () => {
  expect(reattachClear("0.1.20")).toBe(SCREEN_ONLY);
  expect(reattachClear(undefined)).toBe(SCREEN_ONLY);
  expect(reattachClear("unknown")).toBe(SCREEN_ONLY);
});
