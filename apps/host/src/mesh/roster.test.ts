import { base64urlEncode } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { parseRecord, signCard } from "@doriface/mesh";
import { JOINER_EXPECTS, MeshLines, ROSTER_EXPECTS } from "@doriface/mesh/join";
import { parsePolicy } from "@doriface/policy";
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { cardBody } from "../state/mesh.ts";
import {
  admitMembers,
  failure,
  inviteDeps,
  joinerContext,
  removeSides,
  runJoin,
  side,
} from "../testing/join-harness.ts";
import { PendingJoins } from "./pending-joins.ts";
import { noiseOf, signPubOf } from "../testing/mesh-history.ts";
import { serveRoster } from "./roster.ts";
import { RosterAdmits, sweepRoster } from "./roster-admits.ts";

afterEach(removeSides);

import { setup, exchange } from "../testing/roster-harness.ts";

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
  await (
    await exchange(deps, c)
  ).serving;
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
  await (
    await exchange(deps, c)
  ).serving;
  const marker = new RosterAdmits(a.dir);
  expect(marker.read()?.map((entry) => entry.signPub)).toEqual([signPubOf(c.m)]);
  devices.revoke(noiseOf(c.m));
  sweepRoster(deps);
  expect(a.mesh.authorizeIndex()?.client(noiseOf(c.m))).toBeUndefined();
  expect(a.mesh.read()?.records.map((record) => parseRecord(record)?.type)).toEqual(["found", "admit", "revoke"]);
});

test.each(["missing", "malformed", "stale"] as const)("a %s marker cannot burn a client's key", async (mode) => {
  const { a, c, deps, devices } = setup();
  await (
    await exchange(deps, c)
  ).serving;
  devices.revoke(noiseOf(c.m));
  const path = join(a.dir, "roster-admits.json");
  if (mode === "missing") fs.rmSync(path);
  else if (mode === "malformed") fs.writeFileSync(path, "{");
  else
    fs.writeFileSync(
      path,
      JSON.stringify({ version: 1, admits: [{ admitId: "stale", signPub: signPubOf(c.m), devicePub: noiseOf(c.m) }] }),
    );
  sweepRoster(deps);
  expect(a.mesh.authorizeIndex()?.client(noiseOf(c.m))?.signPub).toBe(signPubOf(c.m));
  expect(a.mesh.read()?.records).toHaveLength(2);
});

test("an unreadable devices file signs no revoke", async () => {
  const { a, c, deps } = setup();
  await (
    await exchange(deps, c)
  ).serving;
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

test("two concurrent roster admissions produce one admit and two complete welcomes", async () => {
  const { a, c, deps } = setup();
  const runs = await Promise.all([exchange(deps, c), exchange(deps, c)]);
  expect(await Promise.all(runs.map((run) => run.serving))).toEqual(["resolved", "resolved"]);
  expect(a.mesh.read()?.records).toHaveLength(2);
});

test.each([1, 2])("a client at %s of two machines consumes only one paired-device slot", async (machines) => {
  const { a, c, deps } = setup();
  if (machines === 2) admitMembers(a, ["beta"]);
  const policy = parsePolicy('{"limits":{"machines":2,"devices":1}}');
  expect(await (await exchange({ ...deps, policy }, c)).serving).toBe("resolved");
  const pending = new PendingJoins();
  pending.setAuto(Date.now() + 60_000);
  const d = side("delta");
  const run = runJoin(
    inviteDeps(a, pending, Date.now() + 60_000, policy),
    joinerContext(d, a),
    d.m.identity.noise.publicKey,
  );
  if (machines === 1) expect(await run.joined).toBe(a.mesh.read()?.meshId ?? "");
  else expect(await failure(run.invited)).toContain("allows 2");
});

test("the device budget deduplicates a migrated client but refuses an additional paired device", async () => {
  const { a, c, deps, devices } = setup();
  const policy = parsePolicy('{"limits":{"devices":1}}');
  expect(await (await exchange({ ...deps, policy }, c)).serving).toBe("resolved");
  const other = side("phone");
  devices.add(other.m.identity.noise.publicKey, "phone");
  const before = a.mesh.read()?.records;
  expect(await (await exchange({ ...deps, policy }, other)).serving).toContain("allows 1");
  expect(await (await exchange({ ...deps, policy }, c)).serving).toBe("resolved");
  expect(a.mesh.read()?.records).toEqual(before ?? []);
});

test.each([false, true])("a leave revokes only the session's own client when another=%s", async (another) => {
  const { a, c, deps } = setup();
  await (
    await exchange(deps, c)
  ).serving;
  const [hostEnd, clientEnd] = memoryLinkPair(true);
  const client = new MeshLines(clientEnd, JOINER_EXPECTS);
  const served = failure(serveRoster(new MeshLines(hostEnd, ROSTER_EXPECTS), c.m.identity.noise.publicKey, deps));
  const offer = await client.next();
  if (offer.t !== "offer") throw new Error("no roster offer");
  const signer = another ? side("other") : c;
  const card = signCard(
    cardBody(
      signer.m.identity,
      {
        name: "browser",
        hcId: "",
        devicePub: noiseOf(signer.m),
      },
      offer.mesh,
      offer.inviter,
      offer.nonce,
      "client",
    ),
    signer.m.identity.sign.secretKey,
  );
  client.expect("records", "done", "refused");
  client.send({ t: "leave", card });
  expect(await served).toBe(another ? "the card is not the session's client" : "resolved");
  expect(a.mesh.read()?.records).toHaveLength(another ? 2 : 3);
  expect(a.mesh.authorizeIndex()?.client(noiseOf(c.m)) === undefined).toBe(!another);
});
