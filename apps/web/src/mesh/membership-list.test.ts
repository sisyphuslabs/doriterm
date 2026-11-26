import { base64urlEncode } from "@doriface/crypto";
import { describe, expect, test } from "bun:test";
import { memoryStore } from "../storage/idb.ts";
import { slotStore } from "../storage/key-slot.ts";
import { loadBrowserIdentity, resetBrowserIdentity } from "./identity.ts";
import { type BrowserMembership, BundleRefused, MembershipStore } from "./membership.ts";
import { memberships } from "./membership-list.ts";

const membership = (meshId: string, signPub = "me"): BrowserMembership => ({
  meshId,
  records: [{ body: "{}", sig: "x" }],
  signPub,
  inviter: { hostId: "h", hostKey: "k" },
  relayUrl: "wss://relay.example",
  joinedAt: "2026-11-26T00:00:00.000Z",
});

describe("a browser in several meshes", () => {
  test("holds two memberships side by side, one per key slot", async () => {
    const storage = memoryStore();
    const first = new MembershipStore(storage);
    const second = new MembershipStore(storage, undefined, "second");
    expect(await first.adopt(membership("mesh-1"))).toBe(true);
    expect(await second.adopt(membership("mesh-2", "other"))).toBe(true);
    expect(await first.read()).toEqual(membership("mesh-1"));
    expect(await second.read()).toEqual(membership("mesh-2", "other"));
    expect((await memberships(storage)).map((held) => [held.meshId, held.keySlot])).toEqual([
      ["mesh-1", ""],
      ["mesh-2", "second"],
    ]);
  });

  test("leaving one mesh keeps the other", async () => {
    const storage = memoryStore();
    const first = new MembershipStore(storage);
    const second = new MembershipStore(storage, undefined, "second");
    await first.adopt(membership("mesh-1"));
    await second.adopt(membership("mesh-2", "other"));
    await first.forget();
    expect(await first.read()).toBeUndefined();
    expect(await second.read()).toEqual(membership("mesh-2", "other"));
    expect((await memberships(storage)).map((held) => held.meshId)).toEqual(["mesh-2"]);
  });

  test("a second identity for a mesh already held is refused, and the held one is untouched", async () => {
    const storage = memoryStore();
    await new MembershipStore(storage).adopt(membership("mesh-1"));
    const again = new MembershipStore(storage, undefined, "second");
    await expect(again.adopt(membership("mesh-1", "other"))).rejects.toBeInstanceOf(BundleRefused);
    expect(await again.read()).toBeUndefined();
    expect((await memberships(storage)).map((held) => held.signPub)).toEqual(["me"]);
  });

  test("each key slot has its own signing and device keys, kept across loads", async () => {
    const storage = memoryStore();
    const first = await loadBrowserIdentity(storage, null);
    const second = await loadBrowserIdentity(slotStore(storage, "second"), null);
    const keys = (identity: typeof first) => [identity.card.publicKey, identity.device.publicKey].map(base64urlEncode);
    expect(keys(second)[0]).not.toBe(keys(first)[0]);
    expect(keys(second)[1]).not.toBe(keys(first)[1]);
    await resetBrowserIdentity(slotStore(storage, "second"));
    expect(keys(await loadBrowserIdentity(storage, null))).toEqual(keys(first));
    expect(keys(await loadBrowserIdentity(slotStore(storage, "second"), null))).not.toEqual(keys(second));
  });
});

describe("the single membership of an earlier release", () => {
  test("moves into the list on first read, on the default identity, losing nothing", async () => {
    const storage = memoryStore();
    await storage.put("mesh-membership", membership("mesh-1"));
    expect(await new MembershipStore(storage).read()).toEqual(membership("mesh-1"));
    expect(await new MembershipStore(storage, undefined, "second").read()).toBeUndefined();
    expect(await storage.get("mesh-membership")).toBeNull();
    expect(await storage.get("mesh-memberships")).toEqual([{ ...membership("mesh-1"), keySlot: "" }]);
  });

  test("a second mesh joins beside the migrated one", async () => {
    const storage = memoryStore();
    await storage.put("mesh-membership", membership("mesh-1"));
    expect(await new MembershipStore(storage, undefined, "second").adopt(membership("mesh-2", "other"))).toBe(true);
    expect((await memberships(storage)).map((held) => held.meshId)).toEqual(["mesh-1", "mesh-2"]);
  });

  test("moves in even when written after the list, as a tab still on the earlier release can", async () => {
    const storage = memoryStore();
    expect(await memberships(storage)).toEqual([]);
    await storage.put("mesh-membership", membership("mesh-1"));
    expect(await new MembershipStore(storage).read()).toEqual(membership("mesh-1"));
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
