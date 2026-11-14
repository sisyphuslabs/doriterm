import { expect, test } from "bun:test";
import { colorsOn } from "./sidebar-prefs.ts";

test("a space's saved colour is its colour going through either host (#2537)", () => {
  const saved = { "space:c/s1": "teal", "space:m/s2": "orange" } as const;
  expect(colorsOn(saved, "c")).toEqual({ "space:s1": "teal", "space:m/s2": "orange" });
  expect(colorsOn(saved, "m")).toEqual({ "space:c/s1": "teal", "space:s2": "orange" });
});
