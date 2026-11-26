import { base64urlEncode } from "@doriface/crypto";
import { describe, expect, test } from "bun:test";
import { loadDeviceKey } from "../connection/device-key.ts";
import { type KeyValueStore, memoryStore } from "../storage/idb.ts";
import { beginRetire, finishRetire } from "./enrollment.ts";
import { loadBrowserIdentity } from "./identity.ts";
import { DEFAULT_SLOT, SlotNotEnrolled, slotKeys } from "./identity-slots.ts";
import { joinedStore, meshFixture } from "./mesh-fixture.test-support.ts";

const peer = new Uint8Array(32).fill(9);
const message = new Uint8Array([1, 2, 3]);
const nothing = async (): Promise<void> => undefined;

/**
 * Two contexts over one IndexedDB, as a page and its service worker are: each has its own storage object, so its own
 * `slotKeys` views and key caches, and a leave in one never clears the other's cache.
 */
function twoContexts(): { readonly page: KeyValueStore; readonly worker: KeyValueStore } {
  const backing = memoryStore();
  const viewOf = (): KeyValueStore => ({
    get: (key) => backing.get(key),
    put: (key, value) => backing.put(key, value),
  });
  return { page: viewOf(), worker: viewOf() };
}

async function leaveDefault(page: KeyValueStore): Promise<void> {
  const claim = await beginRetire(page, DEFAULT_SLOT);
  if (claim === undefined) throw new Error("nothing was retired");
  await finishRetire(page, claim, nothing);
}

describe("a key is authorized as itself, not as whatever the slot holds now (review of #2890)", () => {
  test("after the default slot is left and enrolled again, the other context's cached key is never used", async () => {
    const { page, worker } = twoContexts();
    const first = meshFixture();
    const second = meshFixture();
    await joinedStore(page, first, DEFAULT_SLOT);
    const heldDevice = await loadDeviceKey(slotKeys(worker, DEFAULT_SLOT), null);
    const heldIdentity = await loadBrowserIdentity(slotKeys(worker, DEFAULT_SLOT), null);
    expect(base64urlEncode(heldDevice.publicKey)).toBe(first.keys.devicePub);
    await leaveDefault(page);
    await joinedStore(page, second, DEFAULT_SLOT);

    await expect(heldDevice.dh(peer)).rejects.toBeInstanceOf(SlotNotEnrolled);
    await expect(heldIdentity.device.dh(peer)).rejects.toBeInstanceOf(SlotNotEnrolled);
    await expect(heldIdentity.card.sign(message)).rejects.toBeInstanceOf(SlotNotEnrolled);
    const device = await loadDeviceKey(slotKeys(worker, DEFAULT_SLOT), null);
    expect(base64urlEncode(device.publicKey)).toBe(second.keys.devicePub);
    expect(await device.dh(peer)).toHaveLength(32);
    const identity = await loadBrowserIdentity(slotKeys(worker, DEFAULT_SLOT), null);
    expect(base64urlEncode(identity.card.publicKey)).toBe(second.keys.signPub);
    await identity.card.sign(message);
  });

  test("after the default slot is left and a fresh pairing key made there, the cached old key is never used", async () => {
    const { page, worker } = twoContexts();
    await joinedStore(page, meshFixture(), DEFAULT_SLOT);
    const held = await loadDeviceKey(slotKeys(worker, DEFAULT_SLOT), null);
    await leaveDefault(page);
    const fresh = await loadDeviceKey(slotKeys(page, DEFAULT_SLOT), null);
    await expect(held.dh(peer)).rejects.toBeInstanceOf(SlotNotEnrolled);
    const again = await loadDeviceKey(slotKeys(worker, DEFAULT_SLOT), null);
    expect(base64urlEncode(again.publicKey)).toBe(base64urlEncode(fresh.publicKey));
    expect(await again.dh(peer)).toHaveLength(32);
  });

  test("a key swapped into a slot under a live membership is refused against the key recorded for it", async () => {
    const { page, worker } = twoContexts();
    await joinedStore(page, meshFixture(), "second");
    await loadDeviceKey(slotKeys(page, "second"), null);
    await worker.put("mesh-identity/second/device-key", { kind: "raw", privateKey: new Uint8Array(32).fill(7) });
    await expect(loadDeviceKey(slotKeys(worker, "second"), null)).rejects.toBeInstanceOf(SlotNotEnrolled);
  });
});
