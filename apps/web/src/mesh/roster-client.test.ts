import { base64urlEncode, generateHostIdentity } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { hashOf, meshIdOf, signCard, signRecord, verifyCard } from "@doriface/mesh";
import { cardBodyFor, JOINER_EXPECTS, MeshLines, ROSTER_EXPECTS } from "@doriface/mesh/join";
import { expect, test } from "bun:test";
import { loadBrowserIdentity } from "../mesh/identity.ts";
import { memoryStore } from "../storage/idb.ts";
import { MembershipStore } from "./membership.ts";
import { exchangeRoster } from "./roster-client.ts";

async function roster() {
  const storage = memoryStore();
  const identity = await loadBrowserIdentity(storage, null);
  const bundle = new MembershipStore(storage, {
    signPub: base64urlEncode(identity.card.publicKey),
    devicePub: base64urlEncode(identity.device.publicKey),
  });
  const machine = generateHostIdentity();
  const signPub = base64urlEncode(machine.sign.publicKey);
  const own = signCard(
    cardBodyFor(
      { ...machine, noisePub: machine.noise.publicKey },
      { name: "studio", hcId: "core" },
      { mesh: "-", inviter: "-" },
    ),
    machine.sign.secretKey,
  );
  const found = signRecord(
    { v: 2, mesh: "-", type: "found", by: signPub, n: 1, prev: [], subject: { card: own } },
    machine.sign.secretKey,
  );
  const mesh = meshIdOf(found);
  const [hostLink, clientLink] = memoryLinkPair();
  const host = new MeshLines(hostLink, ROSTER_EXPECTS);
  const client = new MeshLines(clientLink, JOINER_EXPECTS);
  const source = { hostId: machine.hostId, hostKey: base64urlEncode(machine.noise.publicKey) };
  return { identity, bundle, machine, signPub, found, mesh, host, client, source };
}

test("a paired browser's roster welcome becomes a verified client membership", async () => {
  const r = await roster();
  const done = exchangeRoster(r.client, {
    identity: r.identity,
    bundle: r.bundle,
    source: r.source,
    name: "phone",
    action: "refresh",
  });
  r.host.send({ t: "offer", mesh: r.mesh, inviter: r.signPub, nonce: base64urlEncode(new Uint8Array(16)) });
  const sent = await r.host.next();
  if (sent.t !== "card") throw new Error("missing client card");
  expect(verifyCard(sent)).toMatchObject({ kind: "client", devicePub: base64urlEncode(r.identity.device.publicKey) });
  const admit = signRecord(
    {
      v: 2,
      mesh: r.mesh,
      type: "admit",
      by: r.signPub,
      n: 2,
      prev: [hashOf(r.found)],
      subject: { card: { body: sent.body, sig: sent.sig } },
    },
    r.machine.sign.secretKey,
  );
  r.host.send({ t: "records", records: [r.found, admit] });
  r.host.send({ t: "done", mesh: r.mesh });
  await done;
  expect(r.bundle.snapshot().phase).toBe("joined");
  expect(r.bundle.snapshot().machines[0]?.hostId).toBe(r.machine.hostId);
});

test("an older or meshless host's refusal keeps the existing empty bundle", async () => {
  const r = await roster();
  const done = exchangeRoster(r.client, {
    identity: r.identity,
    bundle: r.bundle,
    source: r.source,
    name: "phone",
    action: "refresh",
  });
  const rejected = done.catch((error: unknown) => error);
  r.host.send({ t: "refused", reason: "this host is in no mesh" });
  expect(await rejected).toMatchObject({ message: "this host is in no mesh" });
  expect(r.bundle.snapshot().records).toEqual([]);
});

test("Leave supplies only the authenticated browser's signed client card", async () => {
  const r = await roster();
  const done = exchangeRoster(r.client, {
    identity: r.identity,
    bundle: r.bundle,
    source: r.source,
    name: "phone",
    action: "leave",
  });
  const rejected = done.catch((error: unknown) => error);
  r.host.send({ t: "offer", mesh: r.mesh, inviter: r.signPub, nonce: base64urlEncode(new Uint8Array(16)) });
  const sent = await r.host.next();
  if (sent.t !== "leave") throw new Error("missing leave");
  expect(verifyCard(sent.card)).toMatchObject({ signPub: base64urlEncode(r.identity.card.publicKey), kind: "client" });
  r.host.send({ t: "refused", reason: "not a current client" });
  expect(await rejected).toMatchObject({ message: "not a current client" });
});
