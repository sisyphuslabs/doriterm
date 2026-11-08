import { base64urlEncode, generateHostIdentity } from "@doriface/crypto";
import { hashOf, meshIdOf, signCard, signRecord, type Signed, type Subject } from "@doriface/mesh";
import { expect, test } from "bun:test";
import { memoryStore } from "../storage/idb.ts";
import { MembershipStore } from "./membership.ts";

function fixture() {
  const a = generateHostIdentity();
  const b = generateHostIdentity();
  const browser = generateHostIdentity();
  const pub = (who: typeof a) => base64urlEncode(who.sign.publicKey);
  const noise = (who: typeof a) => base64urlEncode(who.noise.publicKey);
  const card = (who: typeof a, mesh: string, inviter: string, client = false) =>
    signCard(
      {
        v: 2,
        kind: client ? "client" : "machine",
        hostId: who.hostId,
        signPub: pub(who),
        noisePub: noise(who),
        devicePub: noise(who),
        name: who === a ? "alpha" : who === b ? "beta" : "phone",
        hcId: client ? "" : "core",
        mesh,
        inviter,
        nonce: base64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
      },
      who.sign.secretKey,
    );
  const found = signRecord(
    { v: 2, mesh: "-", type: "found", by: pub(a), n: 1, prev: [], subject: { card: card(a, "-", "-") } },
    a.sign.secretKey,
  );
  const mesh = meshIdOf(found);
  const records: Signed[] = [found];
  let n = 1;
  const append = (type: "admit" | "revoke", subject: Subject) => {
    const last = records.at(-1);
    if (last === undefined) throw new Error("fixture needs found");
    const signed = signRecord(
      { v: 2, mesh, type, by: pub(a), n: ++n, prev: [hashOf(last)], subject },
      a.sign.secretKey,
    );
    records.push(signed);
    return signed;
  };
  append("admit", { card: card(b, mesh, pub(a)) });
  append("admit", { card: card(browser, mesh, pub(a), true) });
  return {
    a,
    b,
    records,
    mesh,
    anchor: { mesh, inviter: pub(a), hostId: a.hostId, hostKey: noise(a) },
    self: { signPub: pub(browser), devicePub: noise(browser) },
    revoke: (who: typeof a) => append("revoke", { signPubs: [pub(who)], reason: "revoke" }),
    browser,
  };
}

test("an anchored welcome derives every machine and no client as a relay target", async () => {
  const f = fixture();
  const store = new MembershipStore(memoryStore(), f.self);
  await store.accept(f.records, f.anchor);
  expect(store.snapshot().machines.map((m) => m.hostId)).toEqual([f.a.hostId, f.b.hostId]);
  expect(store.snapshot().machines.every((m) => m.directUrl === "")).toBe(true);
  expect(store.snapshot().self?.name).toBe("phone");
});

test("one record failing the door keeps none of a welcome", async () => {
  const f = fixture();
  const store = new MembershipStore(memoryStore(), f.self);
  await expect(store.accept([...f.records, { body: "{}", sig: "invalid" }], f.anchor)).rejects.toThrow();
  expect(store.snapshot().records).toEqual([]);
});

test("welcome must bind the mesh and the authenticated inviter key", async () => {
  const f = fixture();
  const store = new MembershipStore(memoryStore(), f.self);
  await expect(store.accept(f.records, { ...f.anchor, hostKey: f.self.devicePub })).rejects.toThrow();
  await expect(store.accept(f.records, { ...f.anchor, mesh: "another" })).rejects.toThrow();
  expect(store.snapshot().records).toEqual([]);
});

test("refresh cannot erase a held revoke by omitting it", async () => {
  const f = fixture();
  const store = new MembershipStore(memoryStore(), f.self);
  const earlier = [...f.records];
  await store.accept(f.records, f.anchor);
  const revoke = f.revoke(f.b);
  await store.refresh([revoke], f.anchor);
  await store.refresh(earlier, f.anchor);
  expect(store.snapshot().records).toContainEqual(revoke);
  expect(store.snapshot().machines.map((m) => m.hostId)).toEqual([f.a.hostId]);
});

test.each(["revoked", "orphaned"])("a %s browser drops all view targets but retains its bundle", async (reason) => {
  const f = fixture();
  const store = new MembershipStore(memoryStore(), f.self);
  await store.accept(f.records, f.anchor);
  const revoke = f.revoke(reason === "revoked" ? f.browser : f.a);
  await store.refresh([revoke], f.anchor);
  expect(store.snapshot().phase).toBe("removed");
  expect(store.snapshot().machines).toEqual([]);
  expect(store.snapshot().records).toContainEqual(revoke);
});

test("refresh refuses a source not already in the held view with its pinned key", async () => {
  const f = fixture();
  const store = new MembershipStore(memoryStore(), f.self);
  await store.accept(f.records, f.anchor);
  await expect(store.refresh([], { ...f.anchor, hostKey: f.self.devicePub })).rejects.toThrow();
  expect(store.snapshot().machines).toHaveLength(2);
});

test("refresh is bounded once per open and ten minutes per member", () => {
  const f = fixture();
  const store = new MembershipStore(memoryStore(), f.self);
  const first = {};
  expect(store.claimRefresh(f.a.hostId, first, 0)).toBe(true);
  expect(store.claimRefresh(f.a.hostId, first, 600_001)).toBe(false);
  expect(store.claimRefresh(f.a.hostId, {}, 599_999)).toBe(false);
  expect(store.claimRefresh(f.b.hostId, {}, 1)).toBe(true);
  expect(store.claimRefresh(f.a.hostId, {}, 600_000)).toBe(true);
});
