import { base64urlEncode } from "@doriface/crypto";
import { describe, expect, test } from "bun:test";
import { type KeyValueStore, memoryStore } from "../storage/idb.ts";
import { beginRetire, claimSlot, finishRetire, resumeClaim, type RetiringClaim } from "./enrollment.ts";
import { forgetCachedIdentity, loadBrowserIdentity } from "./identity.ts";
import { DEFAULT_SLOT, SlotNotEnrolled, slotKeys } from "./identity-slots.ts";
import { joinedStore, meshFixture } from "./mesh-fixture.test-support.ts";
import { currentRecord } from "./mesh-record.ts";
import { MembershipStore } from "./membership.ts";

const KEYS = ["mesh-sign-key", "device-key", "mesh-sign-key.probe", "device-key.probe"];
const stored = (storage: KeyValueStore, slot: string) =>
  Promise.all(KEYS.map((key) => storage.get(slot === DEFAULT_SLOT ? key : `mesh-identity/${slot}/${key}`)));
const nothing = async (): Promise<void> => undefined;
/** Every owner but the closed tab's is running. */
const live = async (owner: string): Promise<boolean> => owner !== "closed-tab";
const publicKeys = async (storage: KeyValueStore, slot: string) => {
  const identity = await loadBrowserIdentity(slotKeys(storage, slot), null);
  return [identity.card.publicKey, identity.device.publicKey].map(base64urlEncode);
};

async function twoMeshes(): Promise<KeyValueStore> {
  const storage = memoryStore();
  await joinedStore(storage, meshFixture(), DEFAULT_SLOT);
  await joinedStore(storage, meshFixture(), "second");
  return storage;
}

describe("one identity per enrollment", () => {
  test("two joins started at once claim two slots, so neither shows the other's keys", async () => {
    const storage = memoryStore();
    const [first, second] = await Promise.all([claimSlot(storage, "tab-1"), claimSlot(storage, "tab-2")]);
    expect(new Set([first.slot, second.slot]).size).toBe(2);
    expect(first.generation).not.toBe(second.generation);
    const keys = await Promise.all([publicKeys(storage, first.slot), publicKeys(storage, second.slot)]);
    expect(keys[0]?.[0]).not.toBe(keys[1]?.[0]);
    expect(keys[0]?.[1]).not.toBe(keys[1]?.[1]);
  });

  test("two tabs resuming one saved join: one takes it over, the other is told it runs elsewhere and cannot commit", async () => {
    const storage = memoryStore();
    const saved = await claimSlot(storage, "closed-tab");
    const [a, b] = await Promise.all([
      resumeClaim(storage, saved.slot, saved.generation, "tab-a", live),
      resumeClaim(storage, saved.slot, saved.generation, "tab-b", live),
    ]);
    expect([a.kind, b.kind].toSorted()).toEqual(["elsewhere", "resumed"]);
    const winner = a.kind === "resumed" ? a.enrollment : b.kind === "resumed" ? b.enrollment : undefined;
    if (winner === undefined) throw new Error("no tab resumed the join");
    const loser = new MembershipStore(storage, undefined, saved.slot);
    loser.enrolledBy({ ...winner, owner: winner.owner === "tab-a" ? "tab-b" : "tab-a" });
    await expect(loser.adopt(meshFixture().membership)).rejects.toThrow("no longer holds its claim");
    const owner = new MembershipStore(storage, undefined, saved.slot);
    owner.enrolledBy(winner);
    expect(await owner.adopt(meshFixture().membership)).toBe(true);
  });

  test("a join retired meanwhile is ended for good: its saved generation cannot be resumed", async () => {
    const storage = memoryStore();
    const saved = await claimSlot(storage, "closed-tab");
    const claim = await beginRetire(storage, saved.slot, { generation: saved.generation, claimOnly: true });
    if (claim === undefined) throw new Error("nothing was retired");
    await finishRetire(storage, claim, nothing);
    const again = await resumeClaim(storage, saved.slot, saved.generation, "tab-a", async () => false);
    expect(again.kind).toBe("ended");
  });
});

describe("keys are created only by the join that claimed the slot", () => {
  test("a slot that holds no mesh and no claim gets no keys, whoever asks", async () => {
    const storage = memoryStore();
    await expect(loadBrowserIdentity(slotKeys(storage, "stray"), null)).rejects.toBeInstanceOf(SlotNotEnrolled);
    expect(await stored(storage, "stray")).toEqual([undefined, undefined, undefined, undefined]);
  });

  test("an enrolled identity is read-only: keys found missing are not replaced by a dial", async () => {
    const storage = await twoMeshes();
    await storage.put("mesh-identity/second/device-key", null);
    forgetCachedIdentity(slotKeys(storage, "second"));
    await expect(loadBrowserIdentity(slotKeys(storage, "second"), null)).rejects.toBeInstanceOf(SlotNotEnrolled);
  });
});

describe("leaving one mesh", () => {
  test("decides 'last mesh' inside the lock: two meshes left at once, exactly one is the last", async () => {
    const storage = await twoMeshes();
    const claims = await Promise.all([beginRetire(storage, DEFAULT_SLOT), beginRetire(storage, "second")]);
    expect(claims.filter((claim) => claim?.last === true)).toHaveLength(1);
  });

  test("deletes the signing key, the Noise key and both probes", async () => {
    const storage = await twoMeshes();
    await storage.put("mesh-identity/second/device-key.probe", { kind: "raw", privateKey: new Uint8Array(32) });
    const claim = await beginRetire(storage, "second");
    if (claim === undefined) throw new Error("nothing was retired");
    await finishRetire(storage, claim, nothing);
    expect(await stored(storage, "second")).toEqual([null, null, null, null]);
    expect((await currentRecord(storage)).slots).toEqual([]);
  });

  test("a cleanup run late, after the slot was enrolled again, leaves the new identity intact", async () => {
    const storage = memoryStore();
    await joinedStore(storage, meshFixture(), DEFAULT_SLOT);
    const old = await beginRetire(storage, DEFAULT_SLOT);
    if (old === undefined) throw new Error("nothing was retired");
    await finishRetire(storage, old, nothing);
    const next = await claimSlot(storage, "new-tab");
    expect(next.slot).toBe(DEFAULT_SLOT);
    const keys = await publicKeys(storage, DEFAULT_SLOT);
    await finishRetire(storage, old, async () => {
      throw new Error("a stale cleanup must not run its follow-up");
    });
    expect(await publicKeys(storage, DEFAULT_SLOT)).toEqual(keys);
    expect((await currentRecord(storage)).slots).toMatchObject([{ ...next, phase: "enrolling" }]);
  });

  test("a delete that fails leaves the slot retiring, and running the cleanup again finishes it", async () => {
    const storage = await twoMeshes();
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
    const retiring = (await currentRecord(storage)).slots.find(
      (held): held is RetiringClaim => held.phase === "retiring",
    );
    if (retiring === undefined) throw new Error("the slot is not retiring");
    await finishRetire(flaky, retiring, nothing);
    expect(await stored(storage, "second")).toEqual([null, null, null, null]);
  });
});
