import { describe, expect, test } from "bun:test";
import { type KeyValueStore, memoryStore } from "../storage/idb.ts";
import { meshFixture } from "./mesh-fixture.test-support.ts";
import { type BrowserMembership, BundleRefused, MembershipStore } from "./membership.ts";
import { currentRecord, memberships } from "./membership-list.ts";

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

describe("a browser in several meshes", () => {
  test("holds two memberships side by side, one per key slot", async () => {
    const storage = memoryStore();
    expect(await new MembershipStore(storage).adopt(fake("mesh-1"))).toBe(true);
    expect(await new MembershipStore(storage, undefined, "second").adopt(fake("mesh-2", "other"))).toBe(true);
    expect((await memberships(storage)).map((held) => [held.meshId, held.keySlot])).toEqual([
      ["mesh-1", ""],
      ["mesh-2", "second"],
    ]);
  });

  test("a second identity for a mesh already held is refused, and the held one is untouched", async () => {
    const storage = memoryStore();
    await new MembershipStore(storage).adopt(fake("mesh-1"));
    const again = new MembershipStore(storage, undefined, "second");
    await expect(again.adopt(fake("mesh-1", "other"))).rejects.toBeInstanceOf(BundleRefused);
    expect((await memberships(storage)).map((held) => held.signPub)).toEqual(["me"]);
  });
});

describe("the single membership of an earlier release", () => {
  test("moves into the record on first read, on the default identity, losing nothing", async () => {
    const storage = memoryStore();
    await storage.put("mesh-membership", fake("mesh-1"));
    expect(await new MembershipStore(storage).read()).toEqual(fake("mesh-1"));
    expect(await storage.get("mesh-membership")).toBeNull();
  });

  test("written by an earlier-release tab for a mesh already held, its newer verified records are merged in", async () => {
    const storage = memoryStore();
    const mesh = meshFixture(["studio", "workshop", "lab"]);
    const older = { ...mesh.membership, records: mesh.membership.records.slice(0, -2) };
    await new MembershipStore(storage).adopt(older);
    await storage.put("mesh-membership", mesh.membership);
    expect((await new MembershipStore(storage).read())?.records).toEqual(mesh.membership.records);
    expect(await storage.get("mesh-membership")).toBeNull();
  });

  test("one whose records the door refuses stays where it is, and the held membership is unchanged", async () => {
    const storage = memoryStore();
    const mesh = meshFixture();
    await new MembershipStore(storage).adopt(mesh.membership);
    const forged = { ...mesh.membership, records: [{ body: "{}", sig: "forged" }] };
    await storage.put("mesh-membership", forged);
    expect((await new MembershipStore(storage).read())?.records).toEqual(mesh.membership.records);
    expect(await storage.get("mesh-membership")).toEqual(forged);
  });

  test("a write cut short leaves the old entry in place, and the next read takes it in", async () => {
    const storage = memoryStore();
    await storage.put("mesh-membership", fake("mesh-1"));
    await expect(currentRecord(failingOnce(storage, "mesh-memberships"))).rejects.toThrow("cut short");
    expect(await storage.get("mesh-membership")).toEqual(fake("mesh-1"));
    expect((await memberships(storage)).map((held) => held.meshId)).toEqual(["mesh-1"]);
  });

  test("an earlier-release tab and this one writing at once both keep their mesh", async () => {
    const storage = memoryStore();
    const old = meshFixture();
    const current = meshFixture();
    await Promise.all([
      storage.put("mesh-membership", old.membership),
      new MembershipStore(storage, undefined, "second").adopt(current.membership),
    ]);
    const held = await memberships(storage);
    expect(held.map((membership) => [membership.meshId, membership.keySlot]).toSorted()).toEqual(
      [
        [old.membership.meshId, ""],
        [current.membership.meshId, "second"],
      ].toSorted(),
    );
    expect(await storage.get("mesh-membership")).toBeNull();
  });

  test("an unreadable one stays where it is and reads as no membership", async () => {
    const storage = memoryStore();
    const malformed = { meshId: "mesh-1", records: [{ body: 1 }], signPub: "me" };
    await storage.put("mesh-membership", malformed);
    expect(await memberships(storage)).toEqual([]);
    expect(await storage.get("mesh-membership")).toEqual(malformed);
  });
});
