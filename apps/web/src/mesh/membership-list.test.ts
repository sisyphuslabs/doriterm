import { describe, expect, test } from "bun:test";
import { type KeyValueStore, memoryStore } from "../storage/idb.ts";
import { claimSlot } from "./enrollment.ts";
import { abandonJoin } from "./join-claim.ts";
import { type MeshFixture, meshFixture } from "./mesh-fixture.test-support.ts";
import { currentRecord, memberships } from "./mesh-record.ts";
import { type BrowserMembership, BundleRefused, MembershipStore } from "./membership.ts";

const fake = (meshId: string, signPub = "me"): BrowserMembership => ({
  meshId,
  records: [{ body: "{}", sig: "x" }],
  signPub,
  inviter: { hostId: "h", hostKey: "k" },
  relayUrl: "wss://relay.example",
  joinedAt: "2026-11-26T00:00:00.000Z",
});

/** A store whose next put of `key` fails, as a write cut short by a closed tab or a full disk does. */
function failingOnce(storage: KeyValueStore, key: string): KeyValueStore {
  let failed = false;
  return {
    get: (name) => storage.get(name),
    put: async (name, value) => {
      if (name === key && !failed) {
        failed = true;
        throw new Error("the write was cut short");
      }
      await storage.put(name, value);
    },
  };
}

/** What an earlier release left: its single membership and the default signing key that membership names. */
async function earlierRelease(storage: KeyValueStore, mesh: MeshFixture, membership = mesh.membership): Promise<void> {
  await storage.put("mesh-sign-key", { kind: "raw", privateKey: mesh.secrets.sign });
  await storage.put("mesh-membership", membership);
}

async function joined(storage: KeyValueStore, slot: string, membership: BrowserMembership): Promise<boolean> {
  const store = new MembershipStore(storage, undefined, slot);
  await store.enroll();
  return store.adopt(membership);
}

describe("a browser in several meshes", () => {
  test("holds two memberships side by side, one per key slot", async () => {
    const storage = memoryStore();
    expect(await joined(storage, "", fake("mesh-1"))).toBe(true);
    expect(await joined(storage, "second", fake("mesh-2", "other"))).toBe(true);
    expect((await memberships(storage)).map((held) => [held.meshId, held.keySlot])).toEqual([
      ["mesh-1", ""],
      ["mesh-2", "second"],
    ]);
  });

  test("a second identity for a mesh already held is refused, and the held one is untouched", async () => {
    const storage = memoryStore();
    await joined(storage, "", fake("mesh-1"));
    await expect(joined(storage, "second", fake("mesh-1", "other"))).rejects.toBeInstanceOf(BundleRefused);
    expect((await memberships(storage)).map((held) => held.signPub)).toEqual(["me"]);
  });
});

describe("the single membership of an earlier release", () => {
  test("moves into the record on first read, on the default identity it names", async () => {
    const storage = memoryStore();
    const mesh = meshFixture();
    await earlierRelease(storage, mesh);
    expect(await new MembershipStore(storage).read()).toEqual(mesh.membership);
    expect(await storage.get("mesh-membership")).toBeNull();
  });

  test("written by an earlier-release tab for a mesh already held, its newer verified records are merged in", async () => {
    const storage = memoryStore();
    const mesh = meshFixture(["studio", "workshop", "lab"]);
    await joined(storage, "", { ...mesh.membership, records: mesh.membership.records.slice(0, -2) });
    await storage.put("mesh-membership", mesh.membership);
    expect((await new MembershipStore(storage).read())?.records).toEqual(mesh.membership.records);
    expect(await storage.get("mesh-membership")).toBeNull();
  });

  test("one whose records the door refuses stays where it is, and the held membership is unchanged", async () => {
    const storage = memoryStore();
    const mesh = meshFixture();
    await joined(storage, "", mesh.membership);
    const forged = { ...mesh.membership, records: [{ body: "{}", sig: "forged" }] };
    await storage.put("mesh-membership", forged);
    expect((await new MembershipStore(storage).read())?.records).toEqual(mesh.membership.records);
    expect(await storage.get("mesh-membership")).toEqual(forged);
  });

  test("one that names a key this browser does not hold stays where it is, not adopted onto the default slot", async () => {
    const storage = memoryStore();
    const mesh = meshFixture();
    await earlierRelease(storage, meshFixture(), mesh.membership);
    expect(await memberships(storage)).toEqual([]);
    expect(await storage.get("mesh-membership")).toEqual(mesh.membership);
  });

  test("written while a join holds the default slot, it waits there, and is taken in once the slot is free", async () => {
    const storage = memoryStore();
    const mesh = meshFixture();
    await storage.put("mesh-sign-key", { kind: "raw", privateKey: mesh.secrets.sign });
    const join = await claimSlot(storage, "joining-tab");
    expect(join.slot).toBe("");
    await storage.put("mesh-membership", mesh.membership);
    expect(await memberships(storage)).toEqual([]);
    expect(await storage.get("mesh-membership")).toEqual(mesh.membership);
    expect((await currentRecord(storage)).slots).toEqual([{ ...join, phase: "enrolling" }]);
    await abandonJoin(join, storage);
    expect((await memberships(storage)).map((held) => held.meshId)).toEqual([mesh.membership.meshId]);
    expect(await storage.get("mesh-membership")).toBeNull();
  });

  test("a write cut short leaves the old entry in place, and the next read takes it in", async () => {
    const storage = memoryStore();
    const mesh = meshFixture();
    await earlierRelease(storage, mesh);
    await expect(currentRecord(failingOnce(storage, "mesh-memberships"))).rejects.toThrow("cut short");
    expect(await storage.get("mesh-membership")).toEqual(mesh.membership);
    expect((await memberships(storage)).map((held) => held.meshId)).toEqual([mesh.membership.meshId]);
  });

  test("an earlier-release tab and this one writing at once both keep their mesh", async () => {
    const storage = memoryStore();
    const old = meshFixture();
    const current = meshFixture();
    await storage.put("mesh-sign-key", { kind: "raw", privateKey: old.secrets.sign });
    await Promise.all([storage.put("mesh-membership", old.membership), joined(storage, "second", current.membership)]);
    const held = await memberships(storage);
    expect(held.map((membership) => [membership.meshId, membership.keySlot]).toSorted()).toEqual(
      [
        [old.membership.meshId, ""],
        [current.membership.meshId, "second"],
      ].toSorted(),
    );
  });

  test("an unreadable one stays where it is and reads as no membership", async () => {
    const storage = memoryStore();
    const malformed = { meshId: "mesh-1", records: [{ body: 1 }], signPub: "me" };
    await storage.put("mesh-membership", malformed);
    expect(await memberships(storage)).toEqual([]);
    expect(await storage.get("mesh-membership")).toEqual(malformed);
  });
});
