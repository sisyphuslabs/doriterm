import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileHost, nativeTarget } from "../scripts/build-host.ts";

const dir = mkdtempSync(join(tmpdir(), "build-host-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
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
