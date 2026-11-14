import { expect, test } from "bun:test";
import { colorsByCore, colorsOn } from "./sidebar-prefs.ts";

test("a space's saved colour is its colour going through either host (#2537)", () => {
  const saved = { "space:c/s1": "teal", "space:m/s2": "orange" } as const;
  expect(colorsOn(saved, "c")).toEqual({ "space:s1": "teal", "space:m/s2": "orange" });
  expect(colorsOn(saved, "m")).toEqual({ "space:c/s1": "teal", "space:s2": "orange" });
});

test("colours saved before #2537 are rewritten once by the host the page goes through, so a route change keeps them", () => {
  const old = { "space:s1": "teal", "space:m/s2": "orange" } as const;
  const rewritten = colorsByCore(old, "c");
  expect(rewritten).toEqual({ "space:c/s1": "teal", "space:m/s2": "orange" });
  expect(colorsOn(rewritten ?? {}, "m")).toEqual({ "space:c/s1": "teal", "space:s2": "orange" });
  expect(colorsByCore(rewritten ?? {}, "c")).toBeNull();
  expect(colorsByCore(old, "")).toBeNull();
});
