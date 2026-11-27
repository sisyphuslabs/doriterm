import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchHcSession } from "./hc-session.ts";

test("dispose keeps scratch state until the core, not just its control client, exits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dd-stop-test-"));
  const client = join(dir, "control");
  const session = scratchHcSession(client);
  // A separate process owns the state. It flushes one last file after its client has answered stop and exited.
  const core = spawn(process.execPath, [
    "-e",
    `process.stdin.resume(); process.once("SIGUSR2", () => setTimeout(() => {
      require("node:fs").writeFileSync(process.argv[1], "flushed");
      process.exit(0);
    }, 200)); process.stdout.write("ready");`,
    join(session.env["XDG_STATE_HOME"] ?? "", "last-write"),
  ]);
  const exited = once(core, "exit");
  try {
    await once(core.stdout, "data");
    writeFileSync(
      client,
      `#!/bin/sh\nread -r request\nkill -USR2 ${core.pid}\nprintf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"pid":${core.pid}}}' '{"jsonrpc":"2.0","id":2,"result":{}}'\n`,
      {
        mode: 0o755,
      },
    );
    await session.dispose();
    expect((await exited)[0]).toBe(0);
    expect(existsSync(session.env["XDG_STATE_HOME"] ?? "")).toBe(false);
  } finally {
    if (core.exitCode === null && core.signalCode === null) core.kill();
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
