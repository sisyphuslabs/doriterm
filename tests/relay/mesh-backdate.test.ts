import { afterAll, beforeAll, expect, test } from "bun:test";
import { BACKDATE_SHAPES } from "./support/mesh/backdate-graphs.ts";
import { type Mesh, startMesh } from "./support/mesh/mesh.ts";
import { needLib, scenario } from "./support/mesh/present.ts";
import { runAttack } from "./support/mesh/shape-attack.ts";
import { type ShapeRun, setUpShape } from "./support/mesh/shape-setup.ts";

const NEEDS = ["join", "status", "revoke", "bridge", "reconciler", "records", "wire", "sync"] as const;
const FAIL_CLOSED = "removed_undecidable";

for (const shape of BACKDATE_SHAPES) {
  const names = [...new Set(Object.values(shape.hosts))].toSorted();
  const needs = shape.honest.some((step) => step.type === "name") ? [...NEEDS, "rename" as const] : NEEDS;
  scenario(`E-BACKDATE ${shape.id} (${shape.channel} channel)`, needs, () => {
    let mesh: Mesh | undefined;
    let run: ShapeRun | undefined;

    const shaped = (): ShapeRun => {
      if (run === undefined) throw new Error("setup failed");
      return run;
    };

    beforeAll(async () => {
      mesh = await startMesh({ names });
      run = await setUpShape(mesh, needLib(), shape);
    }, 300_000);

    afterAll(async () => {
      await mesh?.dispose();
    });

    test("the honest revoke asks for --yes exactly when its witness pool is empty (the revoke-time warning)", () => {
      expect(shaped().warning).toEqual({ poolEmpty: shape.emptyPool, neededYes: shape.emptyPool });
    });

    test("every judge stores the backdated records, and no minted key is ever listed, dialed or logged by one", async () => {
      const result = await runAttack(shaped());
      expect(result.deliveries).toEqual(shape.channel === "member" ? shape.judges.map(() => "answered") : []);
      expect([...result.judgements.values()]).toEqual(shape.judges.map(() => shape.attack.map(() => "stored")));
      expect(result.sightings).toEqual([]);
      for (const status of result.statuses.values()) {
        expect(status.stuck.includes(FAIL_CLOSED)).toBe(shape.failClosed);
        for (const [key, name] of Object.entries(shape.names ?? {})) {
          const hostId = shaped().mesh.host(shaped().host(key)).hostId;
          expect(status.members.find((member) => member.hostId === hostId)?.name).toBe(name);
        }
      }
    }, 240_000);
  });
}
