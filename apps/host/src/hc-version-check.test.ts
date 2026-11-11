import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hcPipe = join(import.meta.dirname, "hc-pipe.ts");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a process that exits while its hc --version check is still running stops that check (#2066)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-version-check-"));
  let checkPid: number | undefined;
  try {
    // An hc that never answers and never exits on its own, so only its caller can end it; it records its pid.
    const hc = join(dir, "hc");
    const pidFile = join(dir, "pid");
    writeFileSync(hc, `#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\nexec sleep 600\n`);
    chmodSync(hc, 0o755);
    // A caller that starts the check, then gives up and exits, the way a start abandoned by its test does.
    const caller = join(dir, "caller.ts");
    writeFileSync(
      caller,
      [
        `import { readHcVersion } from ${JSON.stringify(hcPipe)};`,
        `void readHcVersion(${JSON.stringify(hc)}).catch(() => {});`,
        `const until = Date.now() + 5_000;`,
        `while (Date.now() < until) {`,
        `  try { if (require("node:fs").readFileSync(${JSON.stringify(pidFile)}, "utf8").trim() !== "") break; } catch {}`,
        `  await Bun.sleep(10);`,
        `}`,
        `process.exit(0);`,
      ].join("\n"),
    );
    const proc = Bun.spawn([process.execPath, caller], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code, stderr).toBe(0);
    checkPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    expect(Number.isInteger(checkPid)).toBe(true);
    // A kill is delivered, not awaited: give the signal a bounded moment to land before reading the outcome.
    const deadline = Date.now() + 1_000;
    // oxlint-disable-next-line no-await-in-loop -- a pid that is not this process's child gives no exit event to await
    while (alive(checkPid) && Date.now() < deadline) await Bun.sleep(10);
    expect(alive(checkPid)).toBe(false);
  } finally {
    if (checkPid !== undefined && alive(checkPid)) process.kill(checkPid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);
