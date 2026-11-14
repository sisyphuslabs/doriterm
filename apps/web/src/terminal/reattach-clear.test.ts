import { expect, test } from "bun:test";
import { reattachClear, repaintingCore } from "./reattach-clear.ts";

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

test("a pre-release or malformed version keeps the primary screen, which a wrong match would erase with no copy (#2516 review)", () => {
  for (const version of ["0.1.21-rc.1", "0.1.20-rc.1", "0.1.21abc", "1.2junk", "0.1", "v0.1.21", "0.1.21.1", ""]) {
    expect(reattachClear(version)).toBe(SCREEN_ONLY);
  }
});

test("a pre-release of a version past 0.1.21 repaints the primary screen like its release does (#2526 review)", () => {
  expect(reattachClear("0.1.22-rc.1")).toBe(PRIMARY_TOO);
  expect(reattachClear("0.2.0-rc.1")).toBe(PRIMARY_TOO);
});

test("a terminal on an added machine is repainted by that machine's core, as machine.list reports it (#2516 review)", () => {
  const views = [
    { name: "build-box", version: "0.1.21" },
    { name: "old-box", version: "0.1.20" },
  ];
  expect(repaintingCore("t3", "0.1.20", views)).toBe("0.1.20");
  expect(repaintingCore("build-box/t3", "0.1.20", views)).toBe("0.1.21");
  expect(repaintingCore("old-box/t3", "0.1.21", views)).toBe("0.1.20");
  expect(repaintingCore("gone-box/t3", "0.1.21", views)).toBeUndefined();
});
