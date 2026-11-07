import { expect, test } from "bun:test";
import { missingSlices } from "../scripts/universal-addon.ts";

// What `lipo -archs` prints for the dictation addon: the slices it holds, separated by spaces, on one line.

test("a universal addon holds both slices", () => {
  expect(missingSlices("x86_64 arm64\n")).toEqual([]);
});

test("an addon built for one architecture is refused, naming the slice it lacks (#1116)", () => {
  expect(missingSlices("arm64\n")).toEqual(["x86_64"]);
  expect(missingSlices("x86_64\n")).toEqual(["arm64"]);
  expect(missingSlices("")).toEqual(["arm64", "x86_64"]);
});

test("an arm64e slice is not the arm64 slice a universal build needs (#1117)", () => {
  expect(missingSlices("x86_64 arm64e\n")).toEqual(["arm64"]);
});
