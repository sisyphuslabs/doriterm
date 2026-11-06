import { describe, expect, test } from "bun:test";
import { hostStartCopy } from "./host-start-copy.ts";

const failure = (code: string, extra: object = {}) => ({ code, message: "m", details: "d", ...extra });

describe("host start copy", () => {
  test("a doriface-host that could not run says so and points at reinstalling, not at a host that stopped", () => {
    const copy = hostStartCopy(failure("host-spawn-failed"));
    expect(copy.cause).toBe("Doriterm could not run its host program.");
    expect(copy.next).toContain("Reinstall Doriterm");
    expect(copy.cause).not.toContain("stopped");
  });

  test("herdr-core not found lists the folders this computer searched, and asks for nothing a desktop app cannot read", () => {
    const windows = ["C:\\Users\\q\\.local\\bin", "C:\\Users\\q\\.cargo\\bin"];
    const copy = hostStartCopy(failure("hc-binary-missing", { path: "hc", searched: windows }));
    expect(copy.next).toBe(
      "Doriterm looks for hc on your PATH and in C:\\Users\\q\\.local\\bin and C:\\Users\\q\\.cargo\\bin. Install herdr-core in one of them, then retry.",
    );
    expect(copy.install).toBe(true);
  });

  test("an hc older than the host supports names its version and asks for an update", () => {
    const copy = hostStartCopy(failure("hc-version-failed", { path: "/u/bin/hc", version: "0.1.0" }));
    expect(copy.cause).toBe("/u/bin/hc is herdr-core 0.1.0, older than Doriterm supports.");
    expect(copy.next).toBe("Update herdr-core, or point HC_BIN at a newer hc, then retry.");
    expect(copy.install).toBe(true);
    expect(hostStartCopy(failure("hc-version-failed", { path: "/u/bin/hc" })).cause).toBe(
      "/u/bin/hc did not answer as herdr-core.",
    );
  });

  test("herdr-core not found with no searched folders names only the PATH, and never HC_BIN", () => {
    const copy = hostStartCopy(failure("hc-binary-missing", { path: "hc" }));
    expect(copy.next).toBe("Doriterm looks for hc on your PATH. Install herdr-core there, then retry.");
    expect(copy.next).not.toContain("/opt/homebrew");
  });
});
