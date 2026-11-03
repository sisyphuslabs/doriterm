import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dialAs } from "./support/mesh/dial.ts";
import { untilFullMesh } from "./support/mesh/echo.ts";
import { untilGone } from "./support/mesh/gone.ts";
import { identityOf, mintIdentity } from "./support/mesh/identity.ts";
import { type Mesh, startMesh } from "./support/mesh/mesh.ts";
import { runs } from "./support/mesh/present.ts";
import { machineIds } from "./support/mesh/status.ts";

const ENABLED = runs("E-OUT and E-REVOKE (outsider refused, revoke and --compromised propagate)", [
  "cli",
  "bridge",
  "reconciler",
]);
const REFUSED = 4401;
let mesh: Mesh | undefined;

const running = (): Mesh => {
  if (mesh === undefined) throw new Error("setup failed");
  return mesh;
};

async function refusedEverywhere(hosts: Mesh, who: string, targets: readonly string[]): Promise<void> {
  const keys = identityOf(hosts.host(who));
  const dialed = await Promise.all(targets.map((target) => dialAs(hosts, keys, hosts.host(target))));
  expect(dialed.map((result) => (result.kind === "refused" ? result.code : result.kind))).toEqual(
    targets.map(() => REFUSED),
  );
}

describe.skipIf(!ENABLED)("outsiders and revoked members", () => {
  beforeAll(async () => {
    mesh = await startMesh();
    await mesh.join("a", "b");
    await mesh.join("a", "c");
    await mesh.join("c", "d");
    await untilFullMesh(mesh, ["a", "b", "c", "d"]);
  }, 240_000);

  afterAll(async () => {
    await mesh?.dispose();
  });

  test("E-OUT: an outsider with no membership is refused by every member with 4401", async () => {
    const hosts = running();
    const outsider = mintIdentity();
    const dialed = await Promise.all(hosts.hosts.map((host) => dialAs(hosts, outsider, host)));
    expect(dialed.map((result) => (result.kind === "refused" ? result.code : result.kind))).toEqual(
      hosts.hosts.map(() => REFUSED),
    );
  }, 60_000);

  test("E-REVOKE: a revoke on a reaches everyone, and the revoked host is refused by all of them", async () => {
    const hosts = running();
    const revoke = await hosts.host("a").cli("mesh", "revoke", "b", "--yes");
    expect(revoke.exit).toBe(0);
    await untilGone(hosts, ["a", "c", "d"], ["b"]);
    await refusedEverywhere(hosts, "b", ["a", "c", "d"]);
    expect(await machineIds(hosts, "b")).toEqual([]);
  }, 120_000);

  test("E-REVOKE: --compromised on c takes d, which c admitted, out of every view with it", async () => {
    const hosts = running();
    const revoke = await hosts.host("a").cli("mesh", "revoke", "--compromised", "c", "--yes");
    expect(revoke.exit).toBe(0);
    await untilGone(hosts, ["a"], ["c", "d"]);
    await refusedEverywhere(hosts, "c", ["a"]);
    await refusedEverywhere(hosts, "d", ["a"]);
  }, 120_000);
});
