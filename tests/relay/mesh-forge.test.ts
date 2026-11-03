import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { deliver } from "./support/mesh/inject.ts";
import { untilFullMesh } from "./support/mesh/echo.ts";
import { identityOf, mintIdentity } from "./support/mesh/identity.ts";
import { type Mesh, startMesh } from "./support/mesh/mesh.ts";
import { needKit, runs } from "./support/mesh/present.ts";
import { actorOf, Chain, foundRecord, lastOwn } from "./support/mesh/records.ts";
import { machineIds, meshIdOf, type SignedRecord, storedRecords, viewOf } from "./support/mesh/status.ts";

const ENABLED = runs("E-FORGE (forged and replayed records)", ["cli", "bridge", "reconciler", "records", "wire"]);
const NAMES = ["a", "b", "c"] as const;
let mesh: Mesh | undefined;

const running = (): Mesh => {
  if (mesh === undefined) throw new Error("setup failed");
  return mesh;
};

/** Every member's view and core machine list: what an injected record must leave exactly as it was. */
async function snapshot(hosts: Mesh): Promise<string> {
  const parts = await Promise.all(
    NAMES.map(async (name) => [await viewOf(hosts.host(name)), await machineIds(hosts, name)]),
  );
  return JSON.stringify(parts);
}

async function injectedLeavesNothing(carrier: string, target: string, records: readonly SignedRecord[]): Promise<void> {
  const hosts = running();
  const before = await snapshot(hosts);
  const delivered = await deliver(
    hosts,
    identityOf(hosts.host(carrier)),
    hosts.host(target),
    meshIdOf(hosts.host(target)),
    records,
  );
  expect(["answered", "closed", "refused"]).toContain(delivered.kind);
  expect(await snapshot(hosts)).toBe(before);
}

describe.skipIf(!ENABLED)("records that must not change anything", () => {
  beforeAll(async () => {
    mesh = await startMesh({ names: NAMES });
    await mesh.join("a", "b");
    await mesh.join("a", "c");
    await untilFullMesh(mesh, NAMES);
  }, 240_000);

  afterAll(async () => {
    await mesh?.dispose();
  });

  test("a record signed by a key that is no member, sent through a member's sync session, has no effect", async () => {
    const hosts = running();
    const kit = needKit();
    const records = storedRecords(hosts.host("a"));
    const outsider = actorOf(mintIdentity(), "intruder", "hc-intruder");
    const head = lastOwn(kit, records, actorOf(identityOf(hosts.host("a")), "a", "").signPub);
    const chain = new Chain(kit, meshIdOf(hosts.host("a")), outsider, { n: 0, hash: head.hash });
    chain.admit(actorOf(mintIdentity(), "second", "hc-second"));
    await injectedLeavesNothing("b", "a", chain.written);
  }, 60_000);

  test("a record whose body was changed after it was signed has no effect", async () => {
    const hosts = running();
    const admit = storedRecords(hosts.host("a")).find((record) => record.body.includes('"type":"admit"'));
    if (admit === undefined) throw new Error("a stores no admit");
    await injectedLeavesNothing("b", "c", [
      { ...admit, body: admit.body.replace('"type":"admit"', '"type": "admit"') },
    ]);
  }, 60_000);

  test("an old admit and its card, replayed to every other member, change nothing", async () => {
    const hosts = running();
    const admit = storedRecords(hosts.host("a")).find((record) => record.body.includes('"type":"admit"'));
    if (admit === undefined) throw new Error("a stores no admit");
    await injectedLeavesNothing("b", "a", [admit]);
    await injectedLeavesNothing("a", "c", [admit]);
  }, 60_000);

  test("another mesh's founding record has no effect", async () => {
    const foreign = foundRecord(needKit(), actorOf(mintIdentity(), "elsewhere", "hc-elsewhere"));
    await injectedLeavesNothing("b", "a", [foreign]);
  }, 60_000);

  test("an outsider's own session is refused with 4401 before any record is read", async () => {
    const hosts = running();
    const delivered = await deliver(hosts, mintIdentity(), hosts.host("a"), meshIdOf(hosts.host("a")), []);
    expect(delivered).toEqual({ kind: "refused", code: 4401 });
  }, 60_000);
});
