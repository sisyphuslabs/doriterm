import { describe, expect, test } from "bun:test";
import type { DirectReason } from "../connection/direct-attempt.ts";
import { installShellForwarder } from "../connection/direct-forward.test-support.ts";
import { sessionPathLabel } from "./session-path.ts";

const REASONS: readonly DirectReason[] = [
  "blocked",
  "unusable-address",
  "no-answer",
  "could-not-connect",
  "authentication-failed",
];

describe("sessionPathLabel", () => {
  test("with the direct path on, the desktop shell names the path the session actually took", () => {
    expect(sessionPathLabel("direct", undefined, true)).toBe("Direct to this host on this network");
    expect(sessionPathLabel("loopback", undefined, true)).toBe("On this computer");
    expect(sessionPathLabel("relay", undefined, true)).toBe("Through the relay");
  });

  test("a browser only ever says the relay: it has no direct path and no direct reason (#1381 §8)", () => {
    expect(sessionPathLabel("direct")).toBe("Through the relay");
    expect(sessionPathLabel("relay", "no-answer")).toBe("Through the relay");
    expect(sessionPathLabel("loopback")).toBe("On this computer");
  });

  test("the desktop shell says the relay too while the direct path is off (#2070)", () => {
    const shell = installShellForwarder();
    try {
      expect(sessionPathLabel("relay")).toBe("Through the relay");
      expect(sessionPathLabel("relay", "no-answer")).toBe("Through the relay");
      expect(sessionPathLabel("loopback")).toBe("On this computer");
    } finally {
      shell.restore();
    }
  });

  test("the shell gives each reason its own words, so none is a silent fallback", () => {
    const labels = new Set(REASONS.map((reason) => sessionPathLabel("relay", reason, true)));
    expect(labels.size).toBe(REASONS.length);
    expect(labels.has(sessionPathLabel("relay", undefined, true))).toBe(false);
  });
});
