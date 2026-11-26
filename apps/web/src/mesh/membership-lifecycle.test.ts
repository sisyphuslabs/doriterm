import { describe, expect, test } from "bun:test";
import { JOIN_ANCHOR_KEY } from "../pair/join-anchor.ts";
import { loadPushRoute, savePushRoute } from "../push/push-route.ts";
import { type KeyValueStore, memoryStore } from "../storage/idb.ts";
import { beginRetire, claimSlot } from "./enrollment.ts";
import { loadBrowserIdentity } from "./identity.ts";
import { DEFAULT_SLOT, slotKeys } from "./identity-slots.ts";
import { abandonJoin } from "./join-claim.ts";
import { joinedStore, meshFixture } from "./mesh-fixture.test-support.ts";
import { currentRecord } from "./mesh-record.ts";
import type { Enrollment } from "./membership-list.ts";
import { forgetMembership, sweep } from "./membership-lifecycle.ts";

const signKey = (storage: KeyValueStore, slot: string) =>
  storage.get(slot === DEFAULT_SLOT ? "mesh-sign-key" : `mesh-identity/${slot}/mesh-sign-key`);

/** A browser already in one mesh on the default identity, so a further join claims a fresh slot. */
async function inOneMesh(): Promise<KeyValueStore> {
  const storage = memoryStore();
  await joinedStore(storage, meshFixture(), DEFAULT_SLOT);
  return storage;
}

/** The default slot was freed by an earlier leave; one mesh is left, on slot "second". */
async function inSecondOnly(): Promise<KeyValueStore> {
  const storage = memoryStore();
  await joinedStore(storage, meshFixture(), "second");
  return storage;
}

/** Another tab's join on the default slot, as far as the code comparison: keys made, join saved. */
async function startJoin(storage: KeyValueStore): Promise<{ readonly join: Enrollment; readonly anchor: object }> {
  const join = await claimSlot(storage, "joining-tab");
  expect(join.slot).toBe(DEFAULT_SLOT);
  await loadBrowserIdentity(slotKeys(storage, join.slot), null);
  const anchor = { keySlot: join.slot, generation: join.generation, name: "joining" };
  await storage.put(JOIN_ANCHOR_KEY, anchor);
  return { join, anchor };
}

async function joinIntact(storage: KeyValueStore, started: { readonly join: Enrollment; readonly anchor: object }) {
  expect(await storage.get("mesh-sign-key")).not.toBeNull();
  expect(await storage.get("device-key")).not.toBeNull();
  expect(await storage.get(JOIN_ANCHOR_KEY)).toEqual(started.anchor);
  expect((await currentRecord(storage)).slots).toMatchObject([{ ...started.join, phase: "enrolling" }]);
}

describe("a join that ends without a mesh", () => {
  test("drops its fresh slot with the keys it made", async () => {
    const storage = await inOneMesh();
    const join = await claimSlot(storage, "tab");
    await loadBrowserIdentity(slotKeys(storage, join.slot), null);
    expect(await signKey(storage, join.slot)).not.toBeNull();
    await abandonJoin(join, storage);
    expect(await signKey(storage, join.slot)).toBeNull();
    expect((await currentRecord(storage)).slots).toEqual([]);
  });

  test("on the default slot keeps the keys, which are also the pairing identity", async () => {
    const storage = memoryStore();
    const join = await claimSlot(storage, "tab");
    await loadBrowserIdentity(slotKeys(storage, join.slot), null);
    await abandonJoin(join, storage);
    expect(await signKey(storage, join.slot)).not.toBeNull();
    expect((await currentRecord(storage)).slots).toEqual([]);
  });
});

describe("the sweep on start", () => {
  test("drops a claim no tab runs and no saved join names, and keeps the live and the saved ones", async () => {
    const storage = await inOneMesh();
    const gone = await claimSlot(storage, "closed-tab");
    const running = await claimSlot(storage, "open-tab");
    const saved = await claimSlot(storage, "closed-but-saved");
    await Promise.all([gone, running, saved].map((join) => loadBrowserIdentity(slotKeys(storage, join.slot), null)));
    await storage.put(JOIN_ANCHOR_KEY, { keySlot: saved.slot, generation: saved.generation });
    await sweep(storage, async (owner) => owner === "open-tab");
    const kept = (await currentRecord(storage)).slots.map((claim) => claim.slot);
    expect(kept.toSorted()).toEqual([running.slot, saved.slot].toSorted());
    expect(await signKey(storage, gone.slot)).toBeNull();
  });
});

describe("leaving the last mesh while another tab joins on the default slot (LOW-5)", () => {
  test("the leave keeps the join's default keys, its saved join and its claim", async () => {
    const storage = await inSecondOnly();
    const started = await startJoin(storage);
    await forgetMembership("second", storage);
    expect((await currentRecord(storage)).memberships).toEqual([]);
    expect(await signKey(storage, "second")).toBeNull();
    await joinIntact(storage, started);
  });

  test("a leave cut short before the join began, finished on the next start, does not reset the join either", async () => {
    const storage = await inSecondOnly();
    const cut = await beginRetire(storage, "second");
    expect(cut?.last).toBe(true);
    const started = await startJoin(storage);
    await sweep(storage, async (owner) => owner === "joining-tab");
    expect(await signKey(storage, "second")).toBeNull();
    await joinIntact(storage, started);
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
    await joinedStore(storage, meshFixture(), "third");
    await forgetMembership("third", storage);
    expect((await loadPushRoute(storage))?.mode).toBe("relay");
  });
});
