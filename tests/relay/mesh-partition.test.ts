import { afterAll, beforeAll, expect, test } from "bun:test";
import { untilFullMesh } from "./support/mesh/echo.ts";
import { type Mesh, startMesh } from "./support/mesh/mesh.ts";
import { scenario } from "./support/mesh/present.ts";
import { viewOf } from "./support/mesh/status.ts";

const NAMES = ["a", "b", "c", "d", "e"] as const;
const SIDE_AB = ["a", "b", "e"] as const;
const SIDE_CD = ["c", "d"] as const;
/**
 * Uplinks stay up, so no return sweep runs: the sides find each other again by probing (section 5.4, at most every
 * 5 minutes), and a found change reaches `machine.list` within 60 s (section 8.2).
 */
const HEAL_MS = 5 * 60_000 + 60_000;
let mesh: Mesh | undefined;

const running = (): Mesh => {
  if (mesh === undefined) throw new Error("setup failed");
  return mesh;
};

const viewText = async (hosts: Mesh, name: string): Promise<string> => JSON.stringify(await viewOf(hosts.host(name)));

scenario(
  "E-PART (a partition between groups, an admit and a rename on either side, heal)",
  ["join", "status", "rename", "bridge", "reconciler", "sync"],
  () => {
    beforeAll(async () => {
      mesh = await startMesh({ names: NAMES });
      await mesh.join("a", "b");
      await mesh.join("a", "c");
      await mesh.join("c", "d");
      await untilFullMesh(mesh, ["a", "b", "c", "d"]);
    }, 300_000);

    afterAll(async () => {
      await mesh?.dispose();
    });

    test("a admits e while c renames d to d2; after the heal every host has both, one view, and matching machines", async () => {
      const hosts = running();
      const idsOf = (names: readonly string[]): readonly string[] => names.map((name) => hosts.host(name).hostId);
      for (const name of SIDE_AB) hosts.host(name).tap?.block(idsOf(SIDE_CD));
      for (const name of SIDE_CD) hosts.host(name).tap?.block(idsOf(SIDE_AB));
      const e = hosts.host("e").hostId;

      await hosts.join("a", "e");
      expect((await hosts.host("c").cli("mesh", "rename", "d", "d2")).exit).toBe(0);
      await hosts.until("each side has its own change", async () => {
        const ab = await Promise.all(["a", "b"].map((name) => viewText(hosts, name)));
        const cd = await Promise.all(SIDE_CD.map((name) => viewText(hosts, name)));
        return ab.every((view) => view.includes(e)) && cd.every((view) => view.includes('"d2"'));
      });
      const across = await Promise.all([
        ...SIDE_AB.map((name) => viewText(hosts, name)),
        ...SIDE_CD.map((name) => viewText(hosts, name)),
      ]);
      expect(across.slice(0, SIDE_AB.length).some((view) => view.includes('"d2"'))).toBe(false);
      expect(across.slice(SIDE_AB.length).some((view) => view.includes(e))).toBe(false);

      for (const host of hosts.hosts) host.tap?.heal();
      await hosts.until(
        "one view on all five hosts, with e a member and d named d2",
        async () => {
          const views = await Promise.all(NAMES.map((name) => viewText(hosts, name)));
          return new Set(views).size === 1 && views.every((view) => view.includes(e) && view.includes('"d2"'));
        },
        HEAL_MS,
      );
      await untilFullMesh(hosts, NAMES);
      const view = await viewOf(hosts.host("a"));
      expect(view).toHaveLength(NAMES.length);
      const names = await Promise.all(
        NAMES.map(async (name) =>
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
    }, 600_000);
  },
);
