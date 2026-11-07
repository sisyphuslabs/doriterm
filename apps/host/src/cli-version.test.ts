import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cli = join(import.meta.dir, "cli.ts");
const release: unknown = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "desktop", "package.json"), "utf8"));
const releaseVersion = typeof release === "object" && release !== null ? Reflect.get(release, "version") : undefined;

test("--version prints the release version, which apps/desktop/package.json holds", () => {
  const run = Bun.spawnSync([process.execPath, cli, "--version"], { stdout: "pipe", stderr: "pipe" });
  expect({ code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() }).toEqual({
    code: 0,
    stdout: `doriface-host ${String(releaseVersion)}\n`,
    stderr: "",
  });
});
