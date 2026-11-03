import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateToken } from "../auth.ts";
import { requestControl } from "../control.ts";
import { type HostOptions, startHost } from "../host.ts";
import { meshFixture } from "../testing/mesh-fixture.ts";
import { resolveHcBin } from "../testing/hc-session.ts";
import { meshStatus } from "./status.ts";

const NOW = new Date("2026-11-03T12:00:00.000Z");

/** Asks a real host's control socket for its mesh status, the way `doriface-host mesh status` does. */
async function askHost(hook: HostOptions["meshStatus"]): Promise<unknown> {
  const stateDir = mkdtempSync(join(tmpdir(), "dh-meshctl-"));
  const host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    token: generateToken(),
    hc: resolveHcBin(),
    stateDir,
    meshStatus: hook,
    log: () => {},
  });
  try {
    return await requestControl(stateDir, { op: "mesh-status" });
  } finally {
    await host.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

describe("the host's mesh-status control op", () => {
  test("answers with what the host's meshStatus hook returns", async () => {
    const status = meshStatus(meshFixture(NOW).sources, NOW);
    expect(await askHost(() => status)).toEqual(status);
  });

  test("answers null on a host in no mesh", async () => {
    expect(await askHost(undefined)).toBeNull();
    expect(await askHost(() => undefined)).toBeNull();
  });
});
