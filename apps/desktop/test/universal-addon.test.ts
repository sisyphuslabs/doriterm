import { expect, test } from "bun:test";
import { checkUniversal, missingSlices } from "../scripts/universal-addon.ts";

// What `lipo -archs` prints for the dictation addon: the slices it holds, separated by spaces, on one line.

const addon = "dist/dictation.node";

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

// The CLI's own path through lipo, with lipo's answer stood in for: a real lipo is only on macOS (#1228).
test("a lipo that failed stops the build, naming the file and lipo's exit code (#1228)", () => {
  expect(() => checkUniversal(addon, () => ({ exitCode: 1, stdout: "" }))).toThrow(`lipo -archs ${addon} exited 1`);
});

test("an addon that lacks a slice stops the build, naming the slice (#1228)", () => {
  expect(() => checkUniversal(addon, () => ({ exitCode: 0, stdout: "arm64\n" }))).toThrow(
    `${addon} is not universal: it lacks x86_64`,
  );
});

test("an addon holding both slices passes (#1228)", () => {
  expect(() => checkUniversal(addon, () => ({ exitCode: 0, stdout: "x86_64 arm64\n" }))).not.toThrow();
});
