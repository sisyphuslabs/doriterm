import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { untilFullMesh } from "./support/mesh/echo.ts";
import { HOST_NAMES, type Mesh, startMesh } from "./support/mesh/mesh.ts";
import { runs } from "./support/mesh/present.ts";
import { viewOf } from "./support/mesh/status.ts";

const ENABLED = runs("E-PART (partition, concurrent renames, heal, converge)", ["cli", "bridge", "reconciler"]);
const HEAL_MS = 120_000;
let mesh: Mesh | undefined;

const running = (): Mesh => {
  if (mesh === undefined) throw new Error("setup failed");
  return mesh;
};

async function views(hosts: Mesh): Promise<string[]> {
  return Promise.all(hosts.hosts.map(async (host) => JSON.stringify(await viewOf(host))));
}

describe.skipIf(!ENABLED)("a partition that heals", () => {
  beforeAll(async () => {
    mesh = await startMesh();
    await mesh.join("a", "b");
    await mesh.join("a", "c");
    await mesh.join("a", "d");
    await untilFullMesh(mesh, HOST_NAMES);
  }, 240_000);

  afterAll(async () => {
    await mesh?.dispose();
  });

  test("hosts that wrote while cut off from the relay agree on one view after it heals, and their cores follow", async () => {
    const hosts = running();
    const taps = hosts.hosts.map((host) => host.tap);
    const dropped = hosts.hosts.map((host) => host.nextLog(/relay: uplink closed/, `${host.name}'s uplink closing`));
    for (const tap of taps) tap?.cut();
    await Promise.all(dropped);
    expect((await hosts.host("a").cli("mesh", "rename", "b", "b2")).exit).toBe(0);
    expect((await hosts.host("c").cli("mesh", "rename", "d", "d2")).exit).toBe(0);
    for (const tap of taps) tap?.heal();
    await hosts.until(
      "one view on every host, with both renames",
      async () => {
        const seen = await views(hosts);
        return new Set(seen).size === 1 && seen.every((view) => view.includes('"b2"') && view.includes('"d2"'));
      },
      HEAL_MS,
    );
    await untilFullMesh(hosts, HOST_NAMES);
    const view = await viewOf(hosts.host("a"));
    const names = await Promise.all(
      HOST_NAMES.map(async (name) =>
        (await (await hosts.core(name)).call("machine.list")).machines.map((machine) => machine.name).toSorted(),
      ),
    );
    expect(names).toEqual(
      hosts.hosts.map((host) =>
        view
          .filter((member) => member.hostId !== host.hostId)
          .map((member) => member.name)
          .toSorted(),
      ),
    );
  }, 300_000);
});
