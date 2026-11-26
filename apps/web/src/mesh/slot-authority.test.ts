import { describe, expect, test } from "bun:test";
import { memoryStore } from "../storage/idb.ts";
import { loadDeviceKey } from "../connection/device-key.ts";
import { beginRetire, claimSlot, finishRetire } from "./enrollment.ts";
import { loadBrowserIdentity } from "./identity.ts";
import { DEFAULT_SLOT, SlotNotEnrolled, slotKeys } from "./identity-slots.ts";
import { joinedStore, meshFixture } from "./mesh-fixture.test-support.ts";

const message = new Uint8Array([1, 2, 3]);
const peer = new Uint8Array(32).fill(9);
const nothing = async (): Promise<void> => undefined;

describe("every use of an enrolled key is authorized live, against storage (review of #2890)", () => {
  test("keys loaded before their mesh was left are refused after, for signing and for Noise", async () => {
    const storage = memoryStore();
    await joinedStore(storage, meshFixture(), DEFAULT_SLOT);
    await joinedStore(storage, meshFixture(), "second");
    const identity = await loadBrowserIdentity(slotKeys(storage, "second"), null);
    const device = await loadDeviceKey(slotKeys(storage, "second"), null);
    await identity.card.sign(message);
    await beginRetire(storage, "second");
    await expect(identity.card.sign(message)).rejects.toBeInstanceOf(SlotNotEnrolled);
    await expect(identity.device.dh(peer)).rejects.toBeInstanceOf(SlotNotEnrolled);
    await expect(device.dh(peer)).rejects.toBeInstanceOf(SlotNotEnrolled);
  });

  test("an operation already running when its mesh is left is refused at its next key use", async () => {
    const storage = memoryStore();
    await joinedStore(storage, meshFixture(), DEFAULT_SLOT);
    await joinedStore(storage, meshFixture(), "second");
    const identity = await loadBrowserIdentity(slotKeys(storage, "second"), null);
    const gate = Promise.withResolvers<void>();
    const running = (async () => {
      await identity.card.sign(message);
      await gate.promise;
      return identity.card.sign(message);
    })();
    await beginRetire(storage, "second");
    gate.resolve();
    await expect(running).rejects.toBeInstanceOf(SlotNotEnrolled);
  });

  test("a key of a retired generation is refused even when its slot is enrolled again", async () => {
    const storage = memoryStore();
    await joinedStore(storage, meshFixture(), DEFAULT_SLOT);
    const old = await loadBrowserIdentity(slotKeys(storage, DEFAULT_SLOT), null);
    const claim = await beginRetire(storage, DEFAULT_SLOT);
    if (claim === undefined) throw new Error("nothing was retired");
    await finishRetire(storage, claim, nothing);
    await claimSlot(storage, "new-tab");
    const renewed = await loadBrowserIdentity(slotKeys(storage, DEFAULT_SLOT), null);
    await renewed.card.sign(message);
    await expect(old.card.sign(message)).rejects.toBeInstanceOf(SlotNotEnrolled);
  });

  test("the default identity with no mesh is the pairing key, used as before", async () => {
    const storage = memoryStore();
    const device = await loadDeviceKey(slotKeys(storage, DEFAULT_SLOT), null);
    expect(await device.dh(peer)).toHaveLength(32);
  });
});
