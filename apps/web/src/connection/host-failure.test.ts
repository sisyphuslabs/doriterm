import { HcCoreMismatchError } from "@doriface/client";
import { describe, expect, test } from "bun:test";
import { hostFailure } from "./host-failure.ts";
import { LoopbackAddressError } from "./loopback-address.ts";
import { LinkCloseError } from "./ws-link.ts";

describe("why the host cannot be reached, in plain words (#477)", () => {
  test("a link that closed abnormally (1006) reads as a sentence with a next step, never as its code", () => {
    const words = hostFailure(new LinkCloseError(1006, ""));
    expect(words).toBe("Your host isn't answering. Check that its computer is on and doriface-host is running.");
    expect(words).not.toContain("1006");
  });

  test("a refused loopback address keeps its own sentence (#462)", () => {
    const refusal = new LoopbackAddressError("The loopback address must be on this computer.");
    expect(hostFailure(refusal)).toBe(refusal.message);
  });

  test.each([
    [
      { kind: "core-too-old", version: "0.1.15", need: "0.1.17" } as const,
      "Your host's herdr-core is 0.1.15, and Doriterm needs 0.1.17 or newer. Run hc update on that computer.",
    ],
    [
      { kind: "core-older", generation: 0, need: "0.1.17" } as const,
      "Your host's herdr-core is too old for Doriterm, which needs 0.1.17 or newer. Run hc update on that computer.",
    ],
    [
      { kind: "core-missing", methods: ["terminal.keys"], need: "0.1.17" } as const,
      "Your host's herdr-core is missing terminal.keys, which Doriterm needs. Run hc update on that computer.",
    ],
    [
      { kind: "core-newer", generation: 2 } as const,
      "Your host's herdr-core is newer than this Doriterm understands. Update Doriterm.",
    ],
  ])("a core this client cannot use says which side to update (#651): %o", (mismatch, words) => {
    expect(hostFailure(new HcCoreMismatchError(mismatch))).toBe(words);
  });
});
