import { describe, expect, test } from "bun:test";
import { CONNECTION_FAILED_EXIT, sessionExitCode } from "./exit-code.ts";

describe("a connect session's exit code (#2019)", () => {
  const failed = new Error("closed with 4401");
  test.each([
    ["the far side closed before its first byte", false, false, undefined, CONNECTION_FAILED_EXIT],
    ["the far side failed before its first byte", false, false, failed, CONNECTION_FAILED_EXIT],
    ["the caller ended it before the far side spoke", false, true, undefined, 0],
    ["the far side spoke and closed normally", true, false, undefined, 0],
    ["the far side spoke and the session then failed", true, false, failed, 1],
    ["the caller ended a session that had spoken", true, true, undefined, 0],
  ])("%s", (_case, spoke, endedByCaller, error, code) => {
    expect(sessionExitCode({ spoke, endedByCaller, error })).toBe(code);
  });
});
