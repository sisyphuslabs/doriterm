import { describe, expect, test } from "bun:test";
import { currentUserSid, lookupAccountSid } from "./native.ts";
import { checkNamespace } from "./namespace.ts";
import { parseSddl } from "./sddl.ts";

// The existing Windows private-state CI job runs this directory and fails if any case skips on Windows.
describe.skipIf(process.platform !== "win32")("LookupAccountSidW diagnostics (#1299)", () => {
  test("W11 resolves the process user with the native UTF-16 sizing and lookup calls", () => {
    const account = lookupAccountSid(currentUserSid());
    expect(account).toMatchObject({ status: "resolved", use: 1 });
    if (account.status !== "resolved") throw new Error("current user SID did not resolve");
    expect(account.name.length).toBeGreaterThan(0);
    expect(account.name).not.toContain("\0");
    expect(account.domain).not.toContain("\0");
  });

  test("W12 resolves a real built-in local group and uses its localized name in the refusal", () => {
    const sid = "S-1-5-32-545";
    const account = lookupAccountSid(sid);
    expect(account).toMatchObject({ status: "resolved", use: 4 });
    if (account.status !== "resolved") throw new Error("built-in Users SID did not resolve");
    expect(account.name.length).toBeGreaterThan(0);
    const user = currentUserSid();
    const verdict = checkNamespace(
      [{ path: "C:\\example", descriptor: parseSddl(`O:${user}D:(A;CI;GW;;;${sid})`), reparsePoint: false }],
      user,
      lookupAccountSid,
    );
    expect(verdict).toMatchObject({
      verdict: "untrusted",
      reason: expect.stringContaining(`a local group named ${account.domain}\\${account.name}`),
    });
  });

  test("W13 distinguishes an unmapped SID from a lookup failure", () => {
    expect(lookupAccountSid("S-1-5-21-0-0-0-4294967295")).toEqual({ status: "unmapped" });
    expect(lookupAccountSid("not-a-sid")).toMatchObject({ status: "unavailable" });
  });
});
