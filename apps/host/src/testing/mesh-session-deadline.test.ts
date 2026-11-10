import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHcSession } from "./hc-session.ts";
import { ownMeshSession } from "./mesh-session.ts";

// #1768: on CI, hc serve made no socket within the deadline and the failure said only that. A stalled core has to name
// its own state (alive or exited, socket path, what it wrote to stderr), so the next one shows which stall it was.
test("a core that makes no socket in time is named: still running, no socket, and its stderr", async () => {
  const bin = mkdtempSync(join(tmpdir(), "fake-hc-"));
  const fake = join(bin, "hc");
  writeFileSync(fake, "#!/bin/sh\necho 'fake core: waiting on something' >&2\nexec sleep 30\n");
  chmodSync(fake, 0o755);
  const scratch = createHcSession("mesh-deadline");
  try {
    const failure = await ownMeshSession({ ...scratch, hc: fake }, { readyWithinMs: 500 }).then(
      () => "",
      (reason: unknown) => String(reason),
    );
    expect(failure).toContain("mesh core did not create its socket within 500 ms");
    expect(failure).toMatch(/hc serve \(pid \d+\) was still running/);
    expect(failure).toContain("socket path absent");
    expect(failure).toContain("fake core: waiting on something");
  } finally {
    await scratch.dispose().catch(() => undefined);
    rmSync(bin, { recursive: true, force: true });
  }
}, 30_000);

test("a core that exits before its socket is named with its exit code and its stderr", async () => {
  const bin = mkdtempSync(join(tmpdir(), "fake-hc-"));
  const fake = join(bin, "hc");
  writeFileSync(fake, "#!/bin/sh\necho 'fake core: cannot start' >&2\nexit 3\n");
  chmodSync(fake, 0o755);
  const scratch = createHcSession("mesh-exit");
  try {
    const failure = await ownMeshSession({ ...scratch, hc: fake }, { readyWithinMs: 10_000 }).then(
      () => "",
      (reason: unknown) => String(reason),
    );
    expect(failure).toContain("mesh core exited before readiness: 3");
    expect(failure).toContain("fake core: cannot start");
  } finally {
    await scratch.dispose().catch(() => undefined);
    rmSync(bin, { recursive: true, force: true });
  }
}, 30_000);
