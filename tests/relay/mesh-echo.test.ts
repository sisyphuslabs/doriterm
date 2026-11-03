import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { directedPairs, echoAll, untilFullMesh } from "./support/mesh/echo.ts";
import { HOST_NAMES, type Mesh, startMesh } from "./support/mesh/mesh.ts";
import { runs } from "./support/mesh/present.ts";
import { viewOf } from "./support/mesh/status.ts";

const ENABLED = runs("E-MESH and E-JOIN (12 echoes, auto-trust)", ["cli", "bridge", "reconciler"]);
let mesh: Mesh | undefined;

const running = (): Mesh => {
  if (mesh === undefined) throw new Error("setup failed");
  return mesh;
};

describe.skipIf(!ENABLED)("a mesh of four hosts through the relay", () => {
  beforeAll(async () => {
    mesh = await startMesh();
    await mesh.join("a", "b");
    await mesh.join("a", "c");
    await untilFullMesh(mesh, ["a", "b", "c"]);
  }, 240_000);

  afterAll(async () => {
    await mesh?.dispose();
  });

  test("E-JOIN: d joins via a, and b and c accept d with no command run on either of them", async () => {
    const hosts = running();
    const [b, c, d] = [hosts.host("b"), hosts.host("c"), hosts.host("d")];
    const stepsBefore = [b.cliCalls(), c.cliCalls()];
    await hosts.join("a", "d");
    await untilFullMesh(hosts, HOST_NAMES);
    expect([b.cliCalls(), c.cliCalls()]).toEqual(stepsBefore);
    const views = await Promise.all([b, c].map(async (host) => (await viewOf(host)).map((member) => member.hostId)));
    for (const view of views) expect(view).toContain(d.hostId);
  }, 120_000);

  test("E-MESH: all 12 directed pairs echo a fresh nonce on the target's own core, each through the relay", async () => {
    const results = await echoAll(running(), HOST_NAMES);
    expect(results).toHaveLength(directedPairs(HOST_NAMES).length);
    expect(results.filter((result) => !result.ok).map((result) => `${result.from}->${result.to}`)).toEqual([]);
    expect(results.every((result) => (result.relayBytes ?? 0) > 0)).toBe(true);
  }, 240_000);
});
