import { describe, expect, test } from "bun:test";
import { CloseCode } from "@doriface/crypto";
import { CONNECTION_FAILED_EXIT, initialFailureExitCode, sessionExitCode } from "./exit-code.ts";

test("an initial 4401 exits 1 for MCP and 255 for the hc line", () => {
  expect(initialFailureExitCode("mcp", 4401)).toBe(1);
  expect(initialFailureExitCode(undefined, 4401)).toBe(255);
});

test("a failed dial exits 255 on either stream", () => {
  for (const code of [CloseCode.HostOffline, CloseCode.CryptoFailure, undefined]) {
    expect(initialFailureExitCode("mcp", code)).toBe(255);
    expect(initialFailureExitCode(undefined, code)).toBe(255);
  }
});

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
