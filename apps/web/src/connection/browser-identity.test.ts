import { ed25519 } from "@noble/curves/ed25519.js";
import { expect, test } from "bun:test";
import { memoryStore, type KeyValueStore } from "../storage/idb.ts";
import { loadBrowserIdentity, resetBrowserIdentity } from "./browser-identity.ts";
import { loadDeviceKey } from "./device-key.ts";

test("concurrent loads create one signing identity and retain the paired device key", async () => {
  const storage = memoryStore();
  const device = await loadDeviceKey(storage, null);
  const [first, second] = await Promise.all([
    loadBrowserIdentity(storage, null),
    loadBrowserIdentity(storage, null),
  ]);
  expect(first.device.publicKey).toEqual(device.publicKey);
  expect(second.card.publicKey).toEqual(first.card.publicKey);
  const message = new TextEncoder().encode("client card");
  expect(ed25519.verify(await first.card.sign(message), message, first.card.publicKey)).toBe(true);
});

test("card keys stay non-extractable when their store preserves CryptoKeys", async () => {
  const storage = memoryStore();
  const identity = await loadBrowserIdentity(storage, crypto.subtle);
  const stored = await storage.get("card-key");
  const privateKey: unknown = Reflect.get(Object(stored), "privateKey");
  expect(privateKey instanceof CryptoKey && privateKey.extractable).toBe(false);
  const message = new Uint8Array([1, 2, 3]);
  expect(ed25519.verify(await identity.card.sign(message), message, identity.card.publicKey)).toBe(true);
});

test("WebKit losing CryptoKeys keeps both raw keys across page loads", async () => {
  const backing = memoryStore();
  const page = (): KeyValueStore => ({
    get: async (key) => {
      const value = await backing.get(key);
      return typeof value === "object" && value !== null && Reflect.get(value, "kind") === "webcrypto"
        ? null
        : value;
    },
    put: (key, value) => backing.put(key, value),
  });
  const first = await loadBrowserIdentity(page(), crypto.subtle);
  const next = await loadBrowserIdentity(page(), crypto.subtle);
  expect(first.card.kind).toBe("raw");
  expect(next.card.publicKey).toEqual(first.card.publicKey);
  expect(next.device.publicKey).toEqual(first.device.publicKey);
});

test("a failed card storage probe does not silently downgrade custody", async () => {
  const backing = memoryStore();
  const storage: KeyValueStore = {
    get: (key) => backing.get(key),
    put: async (key, value) => {
      if (key === "card-key.probe") throw new Error("storage unavailable");
      await backing.put(key, value);
    },
  };
  await expect(loadBrowserIdentity(storage, crypto.subtle)).rejects.toThrow("storage unavailable");
  expect(await backing.get("card-key")).toBeUndefined();
});

test("Join again discards both old keys including in-page cached keys", async () => {
  const storage = memoryStore();
  const before = await loadBrowserIdentity(storage, null);
  await resetBrowserIdentity(storage);
  const after = await loadBrowserIdentity(storage, null);
  expect(after.device.publicKey).not.toEqual(before.device.publicKey);
  expect(after.card.publicKey).not.toEqual(before.card.publicKey);
});
