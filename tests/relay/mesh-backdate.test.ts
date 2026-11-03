import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { deliver } from "./support/mesh/inject.ts";
import { identityOf } from "./support/mesh/identity.ts";
import { type Mesh, startMesh } from "./support/mesh/mesh.ts";
import { needKit, runs } from "./support/mesh/present.ts";
import { type Ctx, makeCtx } from "./support/mesh/shape-ctx.ts";
import { type Runnable, SHAPES } from "./support/mesh/shapes.ts";
import { machineIds, statusOf, viewOf } from "./support/mesh/status.ts";

const REQUIRES = ["cli", "bridge", "reconciler", "records", "wire"] as const;
const FAIL_CLOSED = "removed by an undecidable revoke";

/** Every honest host judges the records, each receiving them through another honest host's session. */
async function inject(shape: Runnable, ctx: Ctx, records: Awaited<ReturnType<Runnable["attack"]>>): Promise<void> {
  const { mesh } = ctx;
  const sessions = shape.honest.map((target, index) => {
    const carrier = shape.honest[(index + 1) % shape.honest.length] ?? target;
    return { target, carrier };
  });
  await Promise.all(
    sessions.map(({ target, carrier }) =>
      deliver(mesh, identityOf(mesh.host(carrier)), mesh.host(target), ctx.meshId, records),
    ),
  );
}

async function expectOutcome(shape: Runnable, ctx: Ctx): Promise<void> {
  const { mesh } = ctx;
  const wanted = shape.members.map((name) => mesh.host(name).hostId).toSorted();
  const wantedCores = await Promise.all(shape.members.map(async (name) => (await mesh.core(name)).hello.core.id));
  await Promise.all(
    shape.honest.map(async (name) => {
      const view = (await viewOf(mesh.host(name))).map((member) => member.hostId).toSorted();
      expect(view).toEqual(wanted);
      expect(view.some((id) => ctx.minted.some((key) => key.keys.hostId === id))).toBe(false);
      expect((await machineIds(mesh, name)).every((id) => wantedCores.includes(id))).toBe(true);
      if (shape.members.length === 0) expect(JSON.stringify(await statusOf(mesh.host(name)))).toContain(FAIL_CLOSED);
    }),
  );
}

for (const shape of SHAPES) {
  if ("gated" in shape) {
    console.log(`GATED E-BACKDATE ${shape.id}: ${shape.gated}`);
    continue;
  }
  describe.skipIf(!runs(`E-BACKDATE ${shape.id}`, REQUIRES))(`E-BACKDATE ${shape.id}`, () => {
    let mesh: Mesh | undefined;
    let ctx: Ctx | undefined;

    beforeAll(async () => {
      mesh = await startMesh({ names: shape.names });
      ctx = makeCtx(mesh, needKit(), shape.founder);
      await shape.setup(ctx);
    }, 300_000);

    afterAll(async () => {
      await mesh?.dispose();
    });

    test("no revoked or minted key becomes a member on any honest host, and no hc line opens to one", async () => {
      if (ctx === undefined) throw new Error("setup failed");
      const records = await shape.attack(ctx);
      await inject(shape, ctx, records);
      await expectOutcome(shape, ctx);
    }, 120_000);
  });
}
