import { afterAll } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stopLeftoverCoresNamed } from "./hc-session.ts";
import { recordLeft, RUN_DIR, RUN_MARK, type RunProcess, stopRunProcesses } from "./run-cores.ts";
import { socketSafeBase } from "./short-tmp.ts";

// Direct `bun test` needs the same ownership boundary as the wrapper, even under a short custom TMPDIR (#1433).
// A nested suite gets its own mark: its sweep must never stop the outer suite.
const ownRun =
  process.env[RUN_DIR] === undefined && process.platform !== "win32"
    ? { mark: crypto.randomUUID(), dir: realpathSync(mkdtempSync(join(socketSafeBase(), "dh-tmp-"))) }
    : undefined;
if (ownRun !== undefined) {
  process.env[RUN_MARK] = ownRun.mark;
  process.env[RUN_DIR] = ownRun.dir;
  process.env["TMPDIR"] = ownRun.dir;
}

// Preloaded by bunfig.toml, so it runs once every test file has: a scratch herdr core still serving then would
// outlive the run, detached from it, so the run fails after stopping it. Under `bun run test` it also records what the
// suite leaves running, for the runner to wait for and stop (see recordLeft).
afterAll(async () => {
  let processesLeft: RunProcess[] = [];
  try {
    const leftover = await stopLeftoverCoresNamed();
    if (leftover.length > 0) {
      throw new Error(`herdr-core outlived the test that started it (now stopped): ${leftover.join(", ")}`);
    }
  } finally {
    try {
      const dir = process.env[RUN_DIR];
      if (dir !== undefined) await recordLeft(dir);
    } finally {
      if (ownRun !== undefined) {
        processesLeft = await stopRunProcesses(ownRun);
        rmSync(ownRun.dir, { recursive: true, force: true });
      }
    }
  }
  if (processesLeft.length > 0) {
    throw new Error(
      `processes outlived the test run (now stopped): ${processesLeft.length}\n` +
        processesLeft.map((child) => `  pid ${child.pid}: ${child.command} (${child.where})`).join("\n"),
    );
  }
}, 60_000);
