import { expect, test } from "bun:test";
import { prunedColors } from "./sidebar-prefs.ts";

const saved = { "space:m/s1": "teal", "space:m/s9": "orange", "space:x/s2": "blue" } as const;

test("a space gone from its machine's read layout loses its colour; a machine not read now keeps every colour (#2583)", () => {
  const read = new Map([["m", ["space:m/s1"]]]);
  expect(prunedColors(saved, read)).toEqual({ "space:m/s1": "teal", "space:x/s2": "blue" });
});

test("nothing to drop leaves the saved colours as they are (#2583)", () => {
  const read = new Map([["m", ["space:m/s1", "space:m/s9"]]]);
  expect(prunedColors(saved, read)).toBe(saved);
});
