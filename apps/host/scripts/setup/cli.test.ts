import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "cli.ts");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Runs the setup CLI with a HOME of its own and a `git` that only records that it ran. */
async function setup(args: readonly string[]): Promise<{ code: number; lines: string[]; gitRan: boolean }> {
  const root = mkdtempSync(join(tmpdir(), "dt-setup-cli-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const gitLog = join(root, "git.log");
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$*" >> "${gitLog}"\nexit 1\n`);
  chmodSync(join(bin, "git"), 0o755);
  const child = Bun.spawn([process.execPath, CLI, ...args, "--src", join(root, "src")], {
    env: { HOME: join(root, "home"), PATH: `${bin}:/usr/bin:/bin` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { code, lines: stdout.trim().split("\n"), gitRan: existsSync(gitLog) && readFileSync(gitLog, "utf8") !== "" };
}

test("a --timeout that is not a positive number is refused before any step runs (#821)", async () => {
  const runs = await Promise.all(["abc", "0", "-5", ""].map((timeout) => setup(["install", `--timeout=${timeout}`])));
  for (const run of runs) {
    expect(run.code).toBe(1);
    // The report line's step and status, as the skill reads them: `doriterm-setup: <step> <status> <detail>`.
    expect(run.lines[0]?.split(" ").slice(0, 3)).toEqual(["doriterm-setup:", "timeout", "fail"]);
    expect(run.gitRan).toBe(false);
  }
});
