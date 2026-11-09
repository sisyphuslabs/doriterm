import { describe, expect, test } from "bun:test";
import { effectivePredictionMode } from "./prediction-mode.ts";

describe("effectivePredictionMode", () => {
  test.each([
    ["adaptive", "loopback", true, "never"],
    ["never", "loopback", true, "never"],
    ["always", "loopback", true, "always"],
    ["adaptive", "relay", true, "adaptive"],
    ["adaptive", "direct", true, "adaptive"],
    ["never", "relay", true, "never"],
    ["adaptive", "loopback", false, "adaptive"],
    ["adaptive", undefined, true, "adaptive"],
  ] as const)("%s over %s (desktop app: %p) predicts %s", (chosen, path, desktop, mode) => {
    expect(effectivePredictionMode(chosen, path, desktop)).toBe(mode);
  });
});
