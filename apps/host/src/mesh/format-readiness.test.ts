import { describe, expect, test } from "bun:test";
import { admissionRefusal, formatReadiness, type FormatSupport } from "./format-readiness.ts";

const NEXT = 3;
const answers = (...support: readonly FormatSupport[]): readonly FormatSupport[] => support;

describe("formatReadiness", () => {
  test("is ready when every member has shown it reads the format", () => {
    expect(
      formatReadiness(["a", "b"], answers({ hostId: "a", reads: [2, 3] }, { hostId: "b", reads: [3] }), NEXT),
    ).toEqual({ kind: "ready" });
  });

  test("blocks on a member that has not answered", () => {
    expect(formatReadiness(["a", "b"], answers({ hostId: "a", reads: [3] }), NEXT)).toEqual({
      kind: "blocked",
      missing: ["b"],
    });
  });

  test("blocks on a member that answered without the format", () => {
    expect(formatReadiness(["a"], answers({ hostId: "a", reads: [2] }), NEXT)).toEqual({
      kind: "blocked",
      missing: ["a"],
    });
  });

  test("a member that left the roster cannot block a write", () => {
    const roster: readonly string[] = ["a"];
    const stale = answers({ hostId: "gone", reads: [2] }, { hostId: "a", reads: [3] });
    expect(formatReadiness(roster, stale, NEXT)).toEqual({ kind: "ready" });
  });

  test("an answer from someone who is not a member never counts as support", () => {
    expect(formatReadiness(["a"], answers({ hostId: "stranger", reads: [3] }), NEXT)).toEqual({
      kind: "blocked",
      missing: ["a"],
    });
  });

  test("a roster with no members is ready, since nothing can be blocked", () => {
    expect(formatReadiness([], [], NEXT)).toEqual({ kind: "ready" });
  });
});

describe("admissionRefusal", () => {
  test("never holds back a machine", () => {
    expect(admissionRefusal("machine", false)).toBeUndefined();
    expect(admissionRefusal(undefined, false)).toBeUndefined();
  });

  test("holds back a client until the cohort is ready", () => {
    expect(admissionRefusal("client", false)).toBe(
      "a client can join once every machine in this mesh reads the new format",
    );
    expect(admissionRefusal("client", true)).toBeUndefined();
  });
});
