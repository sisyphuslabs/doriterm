import { afterAll, expect, test } from "bun:test";
import { HcRpcError } from "@doriface/protocol";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Core, hostIdFor, localHost, startCore } from "./testing/hc-mesh.ts";
import { meshVia, shellQuote } from "./via.ts";

const root = mkdtempSync(join(tmpdir(), "once-"));
const local = localHost();
const started: Core[] = [];
afterAll(async () => {
  await Promise.all(started.map((core) => core.dispose()));
  local.dispose();
  rmSync(root, { recursive: true, force: true });
});

/** The host program, with every line herdr hands it (its last argument) written to `log` before the real CLI runs. */
function loggingProgram(log: string): string {
  const program = join(root, "doriface-host");
  writeFileSync(
    program,
    `#!/bin/sh\nfor last; do :; done\nprintf '%s\\n' "$last" >> ${shellQuote(log)}\nexec ${shellQuote(local.program)} "$@"\n`,
  );
  chmodSync(program, 0o755);
  return program;
}

// herdr dials a via with its POSIX line and, when that ends without a hello and with any status but 255, once more
// with its Windows line (`cmd /d /c "if exist …\herdr-core.exe …"`), which a hello then pins for the core's lifetime
// (herdr-core machines.rs, `probe_windows`). The bridge's 255 keeps a refused mesh dial to one dial (#2019).
test("a refused mesh line is dialed once, with the POSIX line, never herdr's Windows line", async () => {
  const [core] = [await startCore("self")];
  started.push(core);
  const log = join(root, "lines.log");
  writeFileSync(log, "");
  const via = meshVia(loggingProgram(log), local.stateDir, hostIdFor("b"));
  // No host serves line.sock in local.stateDir: every dial is refused with "doriface-host is not running".
  const added = core.control.machines.add("b", via).then(
    () => "added",
    (error: unknown) => (error instanceof HcRpcError ? `${error.kind}: ${error.message}` : String(error)),
  );
  expect(await added).toBe(`unreachable: cannot reach ${via}: doriface-host connect: doriface-host is not running`);
  const lines = readFileSync(log, "utf8").trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toStartWith("sh -c 'p=$(command -v herdr-core)");
  expect(lines.some((line) => line.includes("cmd /d /c"))).toBe(false);
}, 30_000);
