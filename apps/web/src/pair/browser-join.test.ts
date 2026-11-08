import { base64urlEncode } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { joinCommit, JOINER_EXPECTS, MeshLines } from "@doriface/mesh/join";
import { expect, test } from "bun:test";
import { loadBrowserIdentity } from "../connection/browser-identity.ts";
import { memoryStore } from "../storage/idb.ts";
import { BundleStore } from "../mesh/bundle-store.ts";
import { BrowserJoin, loadJoinAnchor } from "./browser-join.ts";

const hash = new Uint8Array(32).fill(1);
const contribution = new Uint8Array(32).fill(2);
const offer = { t: "offer", mesh: "mesh", inviter: base64urlEncode(hash), nonce: base64urlEncode(hash.subarray(0, 16)), commit: joinCommit(hash, contribution) } as const;

async function setup() {
  const storage = memoryStore();
  const identity = await loadBrowserIdentity(storage, null);
  const bundle = new BundleStore(storage, { signPub: base64urlEncode(identity.card.publicKey), devicePub: base64urlEncode(identity.device.publicKey) });
  const join = new BrowserJoin(storage, identity, bundle);
  const pair = () => {
    const [a, b] = memoryLinkPair();
    return { host: new MeshLines(a, ["card", "confirm", "abort", "resume"]), client: new MeshLines(b, JOINER_EXPECTS), close: () => a.close() };
  };
  const context = { name: "phone", relayUrl: "wss://relay.invalid", inviterName: "studio", dialed: { hostId: "inviter", noisePub: base64urlEncode(hash) }, expiresAt: Date.now() + 60_000 };
  return { storage, bundle, join, pair, context };
}

function reaches(join: BrowserJoin, phase: string): Promise<void> {
  return new Promise((resolve) => {
    const read = () => {
      if (join.snapshot().phase !== phase) return;
      off();
      resolve();
    };
    const off = join.subscribe(read);
    read();
  });
}

test("the page confirms only after its person answers and mismatch deletes its anchor", async () => {
  const run = await setup();
  const link = run.pair();
  const done = run.join.run({ lines: link.client, handshakeHash: hash }, run.context);
  link.host.send(offer);
  expect((await link.host.next()).t).toBe("card");
  expect(await loadJoinAnchor(run.storage)).toBeDefined();
  const comparing = reaches(run.join, "comparing");
  link.host.send({ t: "reveal", Ni: base64urlEncode(contribution) });
  await comparing;
  expect(run.bundle.snapshot().phase).toBe("empty");
  run.join.answer(false);
  expect(await link.host.next()).toEqual({ t: "abort" });
  await done;
  expect(await loadJoinAnchor(run.storage)).toBeUndefined();
  expect(run.bundle.snapshot().records).toEqual([]);
  expect(run.join.snapshot().phase).toBe("mismatch");
});

test("matching shows waiting and denial deletes the persisted anchor", async () => {
  const run = await setup();
  const link = run.pair();
  const done = run.join.run({ lines: link.client, handshakeHash: hash }, run.context);
  link.host.send(offer);
  await link.host.next();
  const comparing = reaches(run.join, "comparing");
  link.host.send({ t: "reveal", Ni: base64urlEncode(contribution) });
  await comparing;
  run.join.answer(true);
  expect(await link.host.next()).toEqual({ t: "confirm" });
  expect(run.join.snapshot().phase).toBe("waiting");
  link.host.send({ t: "refused", reason: "denied" });
  await done;
  expect(await loadJoinAnchor(run.storage)).toBeUndefined();
  expect(run.bundle.snapshot().records).toEqual([]);
});

test("a dropped session resumes the same code without another card; refused resume deletes the anchor", async () => {
  const run = await setup();
  const first = run.pair();
  const done = run.join.run({ lines: first.client, handshakeHash: hash }, run.context);
  first.host.send(offer);
  await first.host.next();
  const comparing = reaches(run.join, "comparing");
  first.host.send({ t: "reveal", Ni: base64urlEncode(contribution) });
  await comparing;
  const before = run.join.snapshot();
  first.close();
  await done;
  const anchor = await loadJoinAnchor(run.storage);
  if (anchor === undefined) throw new Error("anchor lost");
  const second = run.pair();
  const resumed = run.join.run({ lines: second.client, handshakeHash: contribution }, { ...run.context, resume: anchor });
  expect(await second.host.next()).toEqual({ t: "resume", nonce: offer.nonce });
  const again = reaches(run.join, "comparing");
  second.host.send({ t: "reveal", Ni: base64urlEncode(contribution) });
  await again;
  expect(run.join.snapshot()).toEqual(before);
  second.host.send({ t: "refused", reason: "pending join withdrawn" });
  await resumed;
  expect(await loadJoinAnchor(run.storage)).toBeUndefined();
  expect(run.join.snapshot()).toMatchObject({ phase: "refused", reason: "Ask for a new invite" });
});

test("an offer without commitment names both causes and sends no card", async () => {
  const run = await setup();
  const link = run.pair();
  const done = run.join.run({ lines: link.client, handshakeHash: hash }, run.context);
  link.host.send({ t: "offer", mesh: offer.mesh, inviter: offer.inviter, nonce: offer.nonce });
  await done;
  expect(run.join.snapshot()).toMatchObject({ phase: "refused" });
  expect(JSON.stringify(run.join.snapshot())).toContain("Add a machine");
  expect(await loadJoinAnchor(run.storage)).toBeUndefined();
});

test("an expired anchor is deleted and asks for a fresh invitation", async () => {
  const run = await setup();
  const link = run.pair();
  const done = run.join.run({ lines: link.client, handshakeHash: hash }, run.context);
  link.host.send(offer);
  await link.host.next();
  link.close();
  await done;
  const anchor = await loadJoinAnchor(run.storage);
  if (anchor === undefined) throw new Error("anchor lost");
  await run.storage.put("mesh.join-anchor", { ...anchor, expiresAt: 0 });
  await expect(loadJoinAnchor(run.storage)).rejects.toThrow("Ask for a new invite");
  expect(await run.storage.get("mesh.join-anchor")).toBeNull();
});
