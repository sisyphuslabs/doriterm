import {
  HcConnectionClosedError,
  HcCoreMismatchError,
  HcHandshakeError,
  HcHandshakeTimeoutError,
  HcProtocolError,
} from "@doriface/client";
import { describe, expect, test } from "bun:test";
import { helloFailureReason } from "./connect.ts";

// #744: this reason is read off the error, never off a clock. Before this, "did the budget expire" was re-derived from
// elapsed time against the remaining budget, so a deadline timer that fired a hair early on a loaded runner reported the
// host as could-not-connect instead of no-answer.
describe("the reason the direct path did not carry the session (#744)", () => {
  test("the hello's own deadline is no-answer, however quickly it arrives", () => {
    expect(helloFailureReason(new HcHandshakeTimeoutError(290))).toBe("no-answer");
    expect(helloFailureReason(new HcHandshakeTimeoutError(0))).toBe("no-answer");
  });

  test("a host that answered with something unusable is could-not-connect, never a silence", () => {
    // HcCoreMismatchError extends HcHandshakeError, so a shortcut on the base class would misreport these as no-answer.
    expect(helloFailureReason(new HcCoreMismatchError({ kind: "core-too-old", version: "0.0.9", need: "0.1.0" }))).toBe(
      "could-not-connect",
    );
    expect(helloFailureReason(new HcHandshakeError("core did not switch to framed mode"))).toBe("could-not-connect");
    expect(helloFailureReason(new HcConnectionClosedError("the socket closed"))).toBe("could-not-connect");
    expect(helloFailureReason(new HcProtocolError("the frame is not a hello reply"))).toBe("could-not-connect");
    expect(helloFailureReason(new Error("something else entirely"))).toBe("could-not-connect");
  });
});
