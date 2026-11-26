import { describe, expect, test } from "bun:test";
import { JOIN_ANCHOR_KEY } from "../pair/join-anchor.ts";
import { loadPushRoute, savePushRoute } from "../push/push-route.ts";
import { type KeyValueStore, memoryStore } from "../storage/idb.ts";
import { loadBrowserIdentity } from "./identity.ts";
import { claimSlot, DEFAULT_SLOT, slotKeys } from "./identity-slots.ts";
import { joinedStore, meshFixture } from "./mesh-fixture.test-support.ts";
import { abandonJoin, forgetMembership, sweep } from "./membership-lifecycle.ts";
import { currentRecord } from "./membership-list.ts";

const signKey = (storage: KeyValueStore, slot: string) =>
  storage.get(slot === DEFAULT_SLOT ? "mesh-sign-key" : `mesh-identity/${slot}/mesh-sign-key`);

/** A browser already in one mesh on the default identity, so a further join claims a fresh slot. */
async function inOneMesh(): Promise<KeyValueStore> {
  const storage = memoryStore();
  await joinedStore(storage, meshFixture(), DEFAULT_SLOT);
  return storage;
}

describe("a join that ends without a mesh", () => {
  test("drops its fresh slot with the keys it made", async () => {
    const storage = await inOneMesh();
    const slot = await claimSlot(storage, "tab");
    await loadBrowserIdentity(slotKeys(storage, slot), null);
    expect(await signKey(storage, slot)).not.toBeNull();
    await abandonJoin(slot, storage);
    expect(await signKey(storage, slot)).toBeNull();
    expect((await currentRecord(storage)).slots).toEqual([]);
  });

  test("on the default slot keeps the keys, which are also the pairing identity", async () => {
    const storage = memoryStore();
    const slot = await claimSlot(storage, "tab");
    expect(slot).toBe(DEFAULT_SLOT);
    await loadBrowserIdentity(slotKeys(storage, slot), null);
    await abandonJoin(slot, storage);
    expect(await signKey(storage, slot)).not.toBeNull();
    expect((await currentRecord(storage)).slots).toEqual([]);
  });
});

describe("the sweep on start", () => {
  test("drops a claim no tab runs and no saved join names, and keeps the live and the saved ones", async () => {
    const storage = await inOneMesh();
    const gone = await claimSlot(storage, "closed-tab");
    const running = await claimSlot(storage, "open-tab");
    const saved = await claimSlot(storage, "closed-but-saved");
    await Promise.all([gone, running, saved].map((slot) => loadBrowserIdentity(slotKeys(storage, slot), null)));
    await storage.put(JOIN_ANCHOR_KEY, { keySlot: saved });
    await sweep(storage, async (owner) => owner === "open-tab");
    expect((await currentRecord(storage)).slots.map((claim) => claim.slot).toSorted()).toEqual(
      [running, saved].toSorted(),
    );
    expect(await signKey(storage, gone)).toBeNull();
    expect(await signKey(storage, running)).not.toBeNull();
  });
});

describe("forgetting one mesh", () => {
  test("keeps the other, deletes its keys and clears a push route that reached it, not one to the other mesh", async () => {
    const storage = await inOneMesh();
    const second = meshFixture();
    await joinedStore(storage, second, "second");
    const route = { mode: "relay", relayUrl: "wss://r", hostId: second.hostIds[0] ?? "", hostKey: "k" } as const;
    await savePushRoute({ ...route, keySlot: "second" }, storage, false);
    await forgetMembership("second", storage);
    expect((await currentRecord(storage)).memberships.map((held) => held.keySlot)).toEqual([DEFAULT_SLOT]);
    expect(await signKey(storage, "second")).toBeNull();
    expect(await storage.get("mesh-identity/second/device-key")).toBeNull();
    expect(await loadPushRoute(storage)).toBeUndefined();

    await savePushRoute({ ...route, keySlot: "kept" }, storage, false);
    const third = meshFixture();
    await joinedStore(storage, third, "third");
    await forgetMembership("third", storage);
    expect((await loadPushRoute(storage))?.mode).toBe("relay");
  });
});
