import { describe, expect, test } from "bun:test";
import type { DirectReason } from "../connection/direct-attempt.ts";
import { sessionPathLabel } from "./session-path.ts";

const REASONS: readonly DirectReason[] = [
  "blocked",
  "unusable-address",
  "no-answer",
  "could-not-connect",
  "authentication-failed",
];

describe("sessionPathLabel", () => {
  test("names the path the session actually took", () => {
    expect(sessionPathLabel("direct")).toBe("Direct to this host on this network");
    expect(sessionPathLabel("loopback")).toBe("On this computer");
    expect(sessionPathLabel("relay")).toBe("Through the relay");
  });

  test("gives each reason its own words, so none is a silent fallback", () => {
    const labels = new Set(REASONS.map((reason) => sessionPathLabel("relay", reason)));
    expect(labels.size).toBe(REASONS.length);
    expect(labels.has(sessionPathLabel("relay"))).toBe(false);
  });
});
