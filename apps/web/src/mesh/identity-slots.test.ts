import { base64urlEncode } from "@doriface/crypto";
import { describe, expect, test } from "bun:test";
import { type KeyValueStore, memoryStore } from "../storage/idb.ts";
import { forgetCachedIdentity, loadBrowserIdentity } from "./identity.ts";
import {
  beginRetire,
  claimSlot,
  DEFAULT_SLOT,
  finishRetire,
  type RetiringClaim,
  SlotNotEnrolled,
  slotKeys,
} from "./identity-slots.ts";
import { joinedStore, meshFixture } from "./mesh-fixture.test-support.ts";
import { currentRecord } from "./membership-list.ts";

const KEYS = ["mesh-sign-key", "device-key", "mesh-sign-key.probe", "device-key.probe"];
const stored = (storage: KeyValueStore, slot: string) =>
  Promise.all(KEYS.map((key) => storage.get(slot === DEFAULT_SLOT ? key : `mesh-identity/${slot}/${key}`)));
const nothing = async (): Promise<void> => undefined;
const publicKeys = async (storage: KeyValueStore, slot: string) => {
  const identity = await loadBrowserIdentity(slotKeys(storage, slot), null);
  return [identity.card.publicKey, identity.device.publicKey].map(base64urlEncode);
};

describe("one identity per enrollment", () => {
  test("two joins started at once claim two slots, so neither shows the other's keys", async () => {
    const storage = memoryStore();
    const [first, second] = await Promise.all([claimSlot(storage, "tab-1"), claimSlot(storage, "tab-2")]);
    expect(new Set([first, second]).size).toBe(2);
    expect([first, second]).toContain(DEFAULT_SLOT);
    const keys = await Promise.all([publicKeys(storage, first ?? ""), publicKeys(storage, second ?? "")]);
    expect(keys[0]?.[0]).not.toBe(keys[1]?.[0]);
    expect(keys[0]?.[1]).not.toBe(keys[1]?.[1]);
  });

  test("a real membership of the earlier release keeps the default identity; a new join gets fresh keys", async () => {
    const storage = memoryStore();
    await storage.put("mesh-membership", meshFixture().membership);
    expect(await claimSlot(storage, "tab-1")).not.toBe(DEFAULT_SLOT);
  });
});

describe("keys are created only by the join that claimed the slot", () => {
  test("a slot that holds no mesh and no claim gets no keys, whoever asks", async () => {
    const storage = memoryStore();
    await expect(loadBrowserIdentity(slotKeys(storage, "stray"), null)).rejects.toBeInstanceOf(SlotNotEnrolled);
    expect(await stored(storage, "stray")).toEqual([undefined, undefined, undefined, undefined]);
  });

  test("an enrolled identity is read-only: keys found missing are not replaced by a dial", async () => {
    const storage = memoryStore();
    await joinedStore(storage, meshFixture(), "second");
    await storage.put("mesh-identity/second/device-key", null);
    forgetCachedIdentity(slotKeys(storage, "second"));
    await expect(loadBrowserIdentity(slotKeys(storage, "second"), null)).rejects.toBeInstanceOf(SlotNotEnrolled);
  });

  test("the default identity with no mesh is the pairing key, created on use as before", async () => {
    const storage = memoryStore();
    expect(await publicKeys(storage, DEFAULT_SLOT)).toHaveLength(2);
  });
});

describe("leaving one mesh", () => {
  test("decides 'last mesh' inside the lock: two meshes left at once, exactly one is the last", async () => {
    const storage = memoryStore();
    await joinedStore(storage, meshFixture(), DEFAULT_SLOT);
    await joinedStore(storage, meshFixture(), "second");
    const claims = await Promise.all([beginRetire(storage, DEFAULT_SLOT), beginRetire(storage, "second")]);
    expect(claims.filter((claim) => claim?.last === true)).toHaveLength(1);
    expect((await currentRecord(storage)).memberships).toEqual([]);
  });

  test("deletes the signing key, the Noise key and both probes, and no load can bring them back meanwhile", async () => {
    const storage = memoryStore();
    await joinedStore(storage, meshFixture(), DEFAULT_SLOT);
    await joinedStore(storage, meshFixture(), "second");
    await storage.put("mesh-identity/second/device-key.probe", { kind: "raw", privateKey: new Uint8Array(32) });
    const claim = await beginRetire(storage, "second");
    if (claim === undefined) throw new Error("nothing was retired");
    expect(claim.last).toBe(false);
    await expect(loadBrowserIdentity(slotKeys(storage, "second"), null)).rejects.toBeInstanceOf(SlotNotEnrolled);
    await finishRetire(storage, claim, nothing);
    expect(await stored(storage, "second")).toEqual([null, null, null, null]);
    expect((await currentRecord(storage)).slots).toEqual([]);
    expect((await stored(storage, DEFAULT_SLOT)).slice(0, 2).every((key) => key != null)).toBe(true);
  });

  test("a delete that fails leaves the slot retiring, and running the cleanup again finishes it", async () => {
    const storage = memoryStore();
    await joinedStore(storage, meshFixture(), DEFAULT_SLOT);
    await joinedStore(storage, meshFixture(), "second");
    let refuse = true;
    const flaky: KeyValueStore = {
      get: (key) => storage.get(key),
      put: async (key, value) => {
        if (refuse && key === "mesh-identity/second/device-key") {
          refuse = false;
          throw new Error("the disk is full");
        }
        await storage.put(key, value);
      },
    };
    const claim = await beginRetire(flaky, "second");
    if (claim === undefined) throw new Error("nothing was retired");
    await expect(finishRetire(flaky, claim, nothing)).rejects.toThrow("disk is full");
    const left = (await currentRecord(storage)).slots;
    expect(left.map((held) => [held.slot, held.phase])).toEqual([["second", "retiring"]]);
    const retiring = left.find((held): held is RetiringClaim => held.phase === "retiring");
    if (retiring === undefined) throw new Error("the slot is not retiring");
    await finishRetire(flaky, retiring, nothing);
    expect(await stored(storage, "second")).toEqual([null, null, null, null]);
    expect((await currentRecord(storage)).slots).toEqual([]);
  });
});
