import { afterAll, beforeAll, expect, test } from "bun:test";
import { directedPairs, echoAll, untilFullMesh } from "./support/mesh/echo.ts";
import { HOST_NAMES, type Mesh, startMesh } from "./support/mesh/mesh.ts";
import { scenario } from "./support/mesh/present.ts";
import { machineIds, statusOf, viewOf } from "./support/mesh/status.ts";

const NAMES = [...HOST_NAMES, "e"] as const;
/** Section 8.2: `machine.list` on every online member reflects a join within 60 s. */
const JOIN_BOUND_MS = 60_000;
let mesh: Mesh | undefined;

const running = (): Mesh => {
  if (mesh === undefined) throw new Error("setup failed");
  return mesh;
};

scenario(
  "E-MESH and E-JOIN (12 directed pairs, a join via a non-founder)",
  ["join", "status", "bridge", "reconciler", "sync"],
  () => {
    beforeAll(async () => {
      mesh = await startMesh({ names: NAMES });
      await mesh.join("a", "b");
      await mesh.join("a", "c");
      await mesh.join("c", "d");
      await untilFullMesh(mesh, HOST_NAMES);
    }, 300_000);

    afterAll(async () => {
      await mesh?.dispose();
    });

    test("E-MESH: every host is ok with 3 machines; all 12 pairs echo a nonce and run a terminal on the target", async () => {
      const hosts = running();
      const statuses = await Promise.all(HOST_NAMES.map((name) => statusOf(hosts.host(name))));
      expect(statuses.map((status) => status.sync)).toEqual(HOST_NAMES.map(() => "ok"));
      const results = await echoAll(hosts, HOST_NAMES);
      expect(results).toHaveLength(directedPairs(HOST_NAMES).length);
      expect(
        results.filter((result) => !result.ok || !result.terminal).map((result) => `${result.from}->${result.to}`),
      ).toEqual([]);
      expect(results.every((result) => (result.relayBytes ?? 0) > 0)).toBe(true);
    }, 240_000);

    test("E-JOIN: e joins via d, and every member lists e as a machine within the bound", async () => {
      const hosts = running();
      const e = hosts.host("e");
      const eCore = (await hosts.core("e")).hello.core.id;
      const joined = Date.now();
      await hosts.join("d", "e");
      await hosts.until(
        "every member lists e as a machine",
        async () =>
          (await Promise.all(HOST_NAMES.map((name) => machineIds(hosts, name)))).every((ids) => ids.includes(eCore)),
        JOIN_BOUND_MS,
      );
      console.log(`E-JOIN: e on every core ${Date.now() - joined} ms after the join command`);
      const views = await Promise.all(
        HOST_NAMES.map(async (name) => (await viewOf(hosts.host(name))).map((member) => member.hostId)),
      );
      expect(views.filter((view) => !view.includes(e.hostId))).toEqual([]);
    }, 120_000);
  },
);
