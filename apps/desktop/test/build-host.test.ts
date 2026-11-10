import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileHost, nativeTarget, resolveTargets } from "../scripts/build-host.ts";

const accepted = "expected all or one of mac-arm64, mac-x64, linux-x64, linux-arm64, win-x64, win-arm64";

const dir = mkdtempSync(join(tmpdir(), "build-host-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A host without a target of its own is a message and exit 2, not an uncaught throw (#1130).
test("no argument on a host the build does not know is refused with the accepted targets (#1130)", () => {
  expect(resolveTargets([], "freebsd", "x64")).toEqual({ error: `unknown host target freebsd-x64; ${accepted}` });
});

test("no argument names this host's target, and all names every target the build packages", () => {
  expect(resolveTargets([], "darwin", "arm64")).toEqual({ names: ["mac-arm64"] });
  expect(resolveTargets(["all"], "darwin", "arm64")).toEqual({
    names: ["mac-arm64", "mac-x64", "linux-x64", "linux-arm64", "win-x64", "win-arm64"],
  });
});

test("a name the build does not know is refused, naming it (#1130)", () => {
  expect(resolveTargets(["freebsd-x64"])).toEqual({ error: `unknown host target freebsd-x64; ${accepted}` });
});

test("an unknown target on the command line prints the accepted targets and exits 2 (#1130)", () => {
  const script = join(import.meta.dir, "..", "scripts", "build-host.ts");
  const run = Bun.spawnSync([process.execPath, script, "freebsd-x64"], { stdout: "pipe", stderr: "pipe" });
  expect({ code: run.exitCode, stderr: run.stderr.toString().trim() }).toEqual({
    code: 2,
    stderr: `unknown host target freebsd-x64; ${accepted}`,
  });
});

// The release builds the host with the version it releases, a prerelease suffix included, and checks it with --version.
test("a host compiled for a release version reports that version", async () => {
  const outfile = join(dir, "doriface-host");
  expect(await compileHost(nativeTarget(), outfile, "9.8.7-rc.1")).toBe(0);
  const run = Bun.spawnSync([outfile, "--version"], { stdout: "pipe", stderr: "pipe" });
  expect({ code: run.exitCode, stdout: run.stdout.toString() }).toEqual({
    code: 0,
    stdout: "doriface-host 9.8.7-rc.1\n",
  });
});
