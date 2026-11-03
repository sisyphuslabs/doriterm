import { afterAll, beforeAll, expect, test } from "bun:test";
import { untilFullMesh } from "./support/mesh/echo.ts";
import { HOST_NAMES, type Mesh, startMesh } from "./support/mesh/mesh.ts";
import { scenario } from "./support/mesh/present.ts";
import { machineIds } from "./support/mesh/status.ts";

let mesh: Mesh | undefined;

const running = (): Mesh => {
  if (mesh === undefined) throw new Error("setup failed");
  return mesh;
};

async function coreIdOf(hosts: Mesh, name: string): Promise<string> {
  return (await hosts.core(name)).hello.core.id;
}

scenario("automatic machine add and remove in hc", ["join", "revoke", "leave", "bridge", "reconciler", "sync"], () => {
  beforeAll(async () => {
    mesh = await startMesh();
    await mesh.join("a", "b");
    await mesh.join("a", "c");
    await untilFullMesh(mesh, ["a", "b", "c"]);
  }, 240_000);

  afterAll(async () => {
    await mesh?.dispose();
  });

  test("a new member appears as a machine on every core, and every core lists exactly the other members", async () => {
    const hosts = running();
    await hosts.join("a", "d");
    await untilFullMesh(hosts, HOST_NAMES);
    const ids = await Promise.all(HOST_NAMES.map((name) => coreIdOf(hosts, name)));
    const lists = await Promise.all(HOST_NAMES.map((name) => machineIds(hosts, name)));
    expect(lists).toEqual(HOST_NAMES.map((_, index) => ids.filter((__, other) => other !== index).toSorted()));
  }, 120_000);

  test("the reconciler added each machine: the pinned `connect --mesh --state-dir <dir> <hostId>` of its member", async () => {
    const hosts = running();
    const machines = (await (await hosts.core("a")).call("machine.list")).machines;
    const stateDir = hosts.host("a").stateDir;
    const others = hosts.hosts.filter((host) => host.name !== "a");
    const reached = machines.map((machine) => others.find((host) => machine.target.endsWith(` ${host.hostId}`))?.name);
    expect(reached.toSorted()).toEqual(others.map((host) => host.name).toSorted());
    for (const machine of machines) {
      const pinned = machine.target.includes(" connect --mesh --state-dir ") && machine.target.includes(stateDir);
      expect([machine.via, pinned]).toEqual([true, true]);
    }
  });

  test("a revoked member is removed from the other cores, and a leaving member removes its own machines", async () => {
    const hosts = running();
    const [dCore, cCore] = await Promise.all([coreIdOf(hosts, "d"), coreIdOf(hosts, "c")]);
    expect((await hosts.host("a").cli("mesh", "revoke", "d", "--yes")).exit).toBe(0);
    await hosts.until("d removed from a, b and c", async () => {
      const lists = await Promise.all(["a", "b", "c"].map((name) => machineIds(hosts, name)));
      return lists.every((ids) => !ids.includes(dCore));
    });
    expect((await hosts.host("c").cli("mesh", "leave")).exit).toBe(0);
    await hosts.until("c's machines gone, and c gone from a and b", async () => {
      const lists = await Promise.all(["a", "b"].map((name) => machineIds(hosts, name)));
      return (await machineIds(hosts, "c")).length === 0 && lists.every((ids) => !ids.includes(cCore));
    });
  }, 180_000);
});
