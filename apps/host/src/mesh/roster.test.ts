import { base64urlEncode } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { parseRecord, signCard } from "@doriface/mesh";
import { JOINER_EXPECTS, MeshLines, ROSTER_EXPECTS } from "@doriface/mesh/join";
import { OPEN_POLICY } from "@doriface/policy";
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { DeviceStore } from "../state/devices.ts";
import { cardBody } from "../state/mesh.ts";
import { failure, ownOf, removeSides, side, type Side } from "../testing/join-harness.ts";
import { noiseOf, signPubOf } from "../testing/mesh-history.ts";
import { serveRoster, type RosterDeps } from "./roster.ts";
import { RosterAdmits, sweepRoster } from "./roster-admits.ts";

afterEach(removeSides);

function setup(found = true) {
  const a = side("alpha");
  const c = side("browser");
  if (found) a.mesh.found(a.m.identity, ownOf(a));
  const devices = new DeviceStore(a.dir);
  devices.add(c.m.identity.noise.publicKey, "browser");
  const deps: RosterDeps = {
    identity: a.m.identity, mesh: a.mesh, devices, stateDir: a.dir,
    policy: OPEN_POLICY, formatReady: () => true, floor: () => undefined, log() {},
  };
  return { a, c, devices, deps };
}

async function exchange(deps: RosterDeps, c: Side, mutate = (card: ReturnType<typeof cardBody>) => card) {
  const [hostEnd, clientEnd] = memoryLinkPair(true);
  const client = new MeshLines(clientEnd, JOINER_EXPECTS);
  const serving = failure(serveRoster(new MeshLines(hostEnd, ROSTER_EXPECTS), c.m.identity.noise.publicKey, deps));
  const offer = await client.next();
  if (offer.t !== "offer") return { serving, client, hostEnd, first: offer };
  const body = mutate(cardBody(c.m.identity, { name: "browser", hcId: "", devicePub: noiseOf(c.m) }, offer.mesh, offer.inviter, offer.nonce, "client"));
  client.expect("records", "done", "refused");
  client.send({ t: "card", ...signCard(body, c.m.identity.sign.secretKey) });
  return { serving, client, hostEnd, first: await client.next() };
}

test("a paired device becomes a client and receives the host's record bundle", async () => {
  const { a, c, deps } = setup();
  const run = await exchange(deps, c);
  expect(run.first.t).toBe("records");
  expect(await run.serving).toBe("resolved");
  expect(a.mesh.authorizeIndex()?.client(noiseOf(c.m))?.signPub).toBe(signPubOf(c.m));
  expect(a.mesh.read()?.records.map((r) => parseRecord(r)?.type)).toEqual(["found", "admit"]);
});

test("the second roster exchange is a refresh and writes no record", async () => {
  const { a, c, deps } = setup();
  await (await exchange(deps, c)).serving;
  const before = a.mesh.read()?.records;
  expect(await (await exchange(deps, c)).serving).toBe("resolved");
  expect(a.mesh.read()?.records).toEqual(before ?? []);
});

test.each(["nonce", "key", "machine"] as const)("a card for another %s is refused without an admit", async (wrong) => {
  const { a, c, deps } = setup();
  const run = await exchange(deps, c, (body) => {
    if (wrong === "nonce") return { ...body, nonce: base64urlEncode(new Uint8Array(16).fill(9)) };
    if (wrong === "key") return { ...body, noisePub: base64urlEncode(new Uint8Array(32).fill(9)) };
    return { ...body, kind: "machine", hcId: "machine-core" };
  });
  expect(run.first.t).toBe("refused");
  expect(await run.serving).not.toBe("resolved");
  expect(a.mesh.read()?.records).toHaveLength(1);
});

test("format readiness refuses client admission before signing", async () => {
  const { a, c, deps } = setup();
  const run = await exchange({ ...deps, formatReady: () => false }, c);
  expect(run.first.t).toBe("refused");
  expect(a.mesh.read()?.records).toHaveLength(1);
});

test("a roster session in no mesh refuses without founding one", async () => {
  const { a, c, deps } = setup(false);
  const run = await exchange(deps, c);
  expect(run.first).toEqual({ t: "refused", reason: "this host is in no mesh" });
  expect(a.mesh.read()).toBeUndefined();
});

test("unpair after the offer but before the card refuses the transaction", async () => {
  const { a, c, deps, devices } = setup();
  const run = await exchange(deps, c, (body) => {
    devices.revoke(noiseOf(c.m));
    return body;
  });
  expect(run.first.t).toBe("refused");
  expect(a.mesh.read()?.records).toHaveLength(1);
});

test("unpair sweeps only the exact admission recorded in the roster marker", async () => {
  const { a, c, deps, devices } = setup();
  await (await exchange(deps, c)).serving;
  const marker = new RosterAdmits(a.dir);
  expect(marker.read()?.map((entry) => entry.signPub)).toEqual([signPubOf(c.m)]);
  devices.revoke(noiseOf(c.m));
  sweepRoster(deps);
  expect(a.mesh.authorizeIndex()?.client(noiseOf(c.m))).toBeUndefined();
  expect(a.mesh.read()?.records.map((record) => parseRecord(record)?.type)).toEqual(["found", "admit", "revoke"]);
});

test.each(["missing", "malformed", "stale"] as const)("a %s marker cannot burn a client's key", async (mode) => {
  const { a, c, deps, devices } = setup();
  await (await exchange(deps, c)).serving;
  devices.revoke(noiseOf(c.m));
  const path = join(a.dir, "roster-admits.json");
  if (mode === "missing") fs.rmSync(path);
  else if (mode === "malformed") fs.writeFileSync(path, "{");
  else fs.writeFileSync(path, JSON.stringify({ version: 1, admits: [{ admitId: "stale", signPub: signPubOf(c.m), devicePub: noiseOf(c.m) }] }));
  sweepRoster(deps);
  expect(a.mesh.authorizeIndex()?.client(noiseOf(c.m))?.signPub).toBe(signPubOf(c.m));
  expect(a.mesh.read()?.records).toHaveLength(2);
});

test("an unreadable devices file signs no revoke", async () => {
  const { a, c, deps } = setup();
  await (await exchange(deps, c)).serving;
  fs.writeFileSync(join(a.dir, "devices.json"), "{");
  sweepRoster(deps);
  expect(a.mesh.read()?.records).toHaveLength(2);
});

test("a failed mesh commit rolls back the marker before releasing the state lock", async () => {
  const { a, c, deps } = setup();
  const original = fs.renameSync;
  const replacement = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(to) === join(a.dir, "mesh.json") && fs.existsSync(join(a.dir, "roster-admits.json"))) {
      throw new Error("mesh commit failed");
    }
    original(from, to);
  });
  try {
    const run = await exchange(deps, c);
    expect(await run.serving).toContain("mesh commit failed");
    expect(new RosterAdmits(a.dir).read() ?? []).toEqual([]);
    expect(a.mesh.read()?.records).toHaveLength(1);
  } finally {
    replacement.mockRestore();
  }
});
