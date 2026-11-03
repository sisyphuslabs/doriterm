import { afterAll, beforeAll, expect, test } from "bun:test";
import { untilFullMesh } from "./support/mesh/echo.ts";
import { type Forbidden, watchForbidden } from "./support/mesh/forbidden-watch.ts";
import { untilGone } from "./support/mesh/gone.ts";
import { identityOf, mintIdentity } from "./support/mesh/identity.ts";
import { deliver, type Judgement, untilJudged } from "./support/mesh/inject.ts";
import { type Mesh, startMesh } from "./support/mesh/mesh.ts";
import { needLib, scenario } from "./support/mesh/present.ts";
import { actorOf, cardIn, cardOf, foundRecord, lastOwn, signAdmit } from "./support/mesh/records.ts";
import { machineIds, meshIdOf, type SignedRecord, storedRecords, viewOf } from "./support/mesh/status.ts";

const NAMES = ["a", "b", "c", "d"] as const;
const WATCHERS = ["a", "b", "c"] as const;
const NOTHING: Forbidden = { hostIds: [], coreIds: [] };
let mesh: Mesh | undefined;

const running = (): Mesh => {
  if (mesh === undefined) throw new Error("setup failed");
  return mesh;
};

async function snapshot(hosts: Mesh): Promise<string> {
  const parts = await Promise.all(
    WATCHERS.map(async (name) => [await viewOf(hosts.host(name)), await machineIds(hosts, name)]),
  );
  return JSON.stringify(parts);
}

/**
 * Sends `records` to `target` on a sync session opened with the member `carrier`'s keys, waits until the target has
 * judged every one, and checks that nothing a member sees changed and no forbidden key showed up meanwhile.
 */
async function injected(carrier: string, target: string, records: readonly SignedRecord[], forbidden = NOTHING) {
  const hosts = running();
  const lib = needLib();
  const hashes = records.map((record) => lib.hashOf(record));
  const held = new Set(storedRecords(hosts.host(target)).map((record) => lib.hashOf(record)));
  expect(hashes.filter((hash) => held.has(hash))).toEqual([]);
  const before = await snapshot(hosts);
  const watch = watchForbidden(hosts, WATCHERS, forbidden);
  const session = await deliver({
    mesh: hosts,
    carrier: identityOf(hosts.host(carrier)),
    target: hosts.host(target),
    meshId: meshIdOf(hosts.host(target)),
    records,
  });
  try {
    expect(session.kind).toBe("answered");
    const judged = await untilJudged(hosts, hosts.host(target), hashes, lib.hashOf);
    expect(await snapshot(hosts)).toBe(before);
    expect(await watch.stop()).toEqual([]);
    return hashes.map((hash): Judgement | undefined => judged.get(hash));
  } finally {
    session.close();
  }
}

scenario(
  "E-FORGE (forged and replayed records)",
  ["join", "status", "revoke", "bridge", "reconciler", "records", "wire", "sync"],
  () => {
    beforeAll(async () => {
      mesh = await startMesh({ names: NAMES });
      await mesh.join("a", "b");
      await mesh.join("a", "c");
      await mesh.join("a", "d");
      await untilFullMesh(mesh, NAMES);
    }, 300_000);

    afterAll(async () => {
      await mesh?.dispose();
    });

    test("an admit signed by a key that is no member waits in the dangling pool (3.3, rule 4) and changes nothing", async () => {
      const hosts = running();
      const lib = needLib();
      const a = hosts.host("a");
      const outsider = actorOf(mintIdentity(), "intruder", "hc-intruder");
      const second = actorOf(mintIdentity(), "second", "hc-second");
      const head = lastOwn(lib, storedRecords(a), actorOf(identityOf(a), "a", "").signPub);
      const meshId = meshIdOf(a);
      const card = cardOf(lib, meshId, outsider.signPub, second);
      const admit = signAdmit({ lib, mesh: meshId, by: outsider, n: 1, prev: [head.hash] }, card);
      const forbidden = { hostIds: [outsider.keys.hostId, second.keys.hostId], coreIds: [outsider.hcId, second.hcId] };
      expect(await injected("b", "a", [admit], forbidden)).toEqual(["dangling"]);
    }, 120_000);

    test("a record whose body changed after it was signed is refused at the door (3.3, rule 1)", async () => {
      const admit = storedRecords(running().host("a")).find((record) => record.body.includes('"type":"admit"'));
      if (admit === undefined) throw new Error("a stores no admit");
      const tampered = { ...admit, body: admit.body.replace('"type":"admit"', '"type": "admit"') };
      expect(await injected("b", "c", [tampered])).toEqual(["refused"]);
    }, 120_000);

    test("another mesh's founding record is refused at the door (3.3, rule 2)", async () => {
      const foreign = foundRecord(needLib(), actorOf(mintIdentity(), "elsewhere", "hc-elsewhere"));
      expect(await injected("b", "a", [foreign])).toEqual(["refused"]);
    }, 120_000);

    test("after d is revoked, a new admit replaying d's old card is refused on every member (3.3, a nonce admits once)", async () => {
      const hosts = running();
      const lib = needLib();
      expect((await hosts.host("a").cli("mesh", "revoke", "d", "--yes")).exit).toBe(0);
      await untilGone(hosts, WATCHERS, ["d"]);
      const a = actorOf(identityOf(hosts.host("a")), "a", "");
      const d = actorOf(identityOf(hosts.host("d")), "d", "");
      const stored = storedRecords(hosts.host("a"));
      const oldCard = stored.map(cardIn).find((card) => card?.body.includes(d.signPub));
      if (oldCard === undefined) throw new Error("a stores no admit of d");
      const head = lastOwn(lib, stored, a.signPub);
      const signing = { lib, mesh: meshIdOf(hosts.host("a")), by: a, n: head.n + 1, prev: [head.hash] };
      const replay = signAdmit(signing, oldCard);
      const dCore = (await hosts.core("d")).hello.core.id;
      const forbidden = { hostIds: [], coreIds: [dCore] };
      expect(await injected("b", "a", [replay], forbidden)).toEqual(["refused"]);
      expect(await injected("a", "c", [replay], forbidden)).toEqual(["refused"]);
    }, 180_000);

    test("an outsider's own sync session is refused with 4401 before any record is read", async () => {
      const hosts = running();
      const target = hosts.host("a");
      const session = await deliver({
        mesh: hosts,
        carrier: mintIdentity(),
        target,
        meshId: meshIdOf(target),
        records: [],
      });
      expect({ kind: session.kind, code: session.code }).toEqual({ kind: "refused", code: 4401 });
    }, 60_000);
  },
);
