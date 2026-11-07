import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateToken } from "../auth.ts";
import { requestControl } from "../control.ts";
import { type HostOptions, startHost } from "../host.ts";
import { meshFixture } from "../testing/mesh-fixture.ts";
import { createHcSession } from "../testing/hc-session.ts";
import { IDLE_MESH_HOOKS } from "./host-hooks.ts";
import { meshStatus } from "./status.ts";

const NOW = new Date("2026-11-03T12:00:00.000Z");

/** Asks a real host's control socket for its mesh status, the way `doriface-host mesh status` does. */
async function askHost(hook: HostOptions["meshStatus"], meshHooks?: HostOptions["meshHooks"]): Promise<unknown> {
  const stateDir = mkdtempSync(join(tmpdir(), "dh-meshctl-"));
  // Its own scratch core: a host on the default session would start the default core on any call to the core.
  const session = createHcSession("meshctl");
  const host = await startHost({
    listen: { hostname: "127.0.0.1", port: 0 },
    token: generateToken(),
    hc: session.hc,
    session: session.name,
    env: session.env,
    stateDir,
    meshStatus: hook,
    meshHooks,
    log: () => {},
  });
  try {
    return await requestControl(stateDir, { op: "mesh-status" });
  } finally {
    await host.stop();
    await session.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

describe("the host's mesh-status control op", () => {
  test("answers with what the host's meshStatus hook returns", async () => {
    const status = meshStatus(meshFixture(NOW).sources, NOW);
    expect(await askHost(() => status)).toEqual(status);
  });

  test("reads herdr's machine list again before it answers, so a line reads as herdr lists it now (#754)", async () => {
    const status = meshStatus(meshFixture(NOW).sources, NOW);
    let refreshed = false;
    const hooks = {
      ...IDLE_MESH_HOOKS,
      refreshLines: () => {
        refreshed = true;
        return Promise.resolve();
      },
    };
    expect(await askHost(() => (refreshed ? status : undefined), hooks)).toEqual(status);
  });

  test("answers null on a host in no mesh", async () => {
    expect(await askHost(undefined)).toBeNull();
    expect(await askHost(() => undefined)).toBeNull();
  });
});
