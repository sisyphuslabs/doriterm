import { x25519 } from "@noble/curves/ed25519.js";
import { describe, expect, test } from "bun:test";
import { memoryStore, type KeyValueStore } from "../storage/idb.ts";
import { loadDeviceKey } from "./device-key.ts";

describe("loadDeviceKey", () => {
  test("WebKit hands a stored CryptoKey back as null, and the device keeps one identity across loads (#1329)", async () => {
    const backing = memoryStore();
    const lossy = (): KeyValueStore => ({
      get: async (key) => {
        const value = await backing.get(key);
        return (value as { readonly kind?: string } | null)?.kind === "webcrypto" ? null : value;
      },
      put: (key, value) => backing.put(key, value),
    });
    const subtle = globalThis.crypto.subtle;
    const first = await loadDeviceKey(lossy(), subtle);
    const afterReload = await loadDeviceKey(lossy(), subtle);
    expect(afterReload.publicKey).toEqual(first.publicKey);
  });

  test("without WebCrypto X25519 it keeps raw bytes and agrees with a noble peer", async () => {
    const storage = memoryStore();
    const key = await loadDeviceKey(storage, null);
    expect(key.kind).toBe("raw");
    const peerPrivate = x25519.utils.randomSecretKey();
    const shared = await key.dh(x25519.getPublicKey(peerPrivate));
    expect(shared).toEqual(x25519.getSharedSecret(peerPrivate, key.publicKey));
    const again = await loadDeviceKey(storage, null);
    expect(again.publicKey).toEqual(key.publicKey);
  });

  test("a store that throws on write is not read as a browser that cannot keep keys (#1329 review)", async () => {
    const backing = memoryStore();
    const storage: KeyValueStore = {
      get: (key) => backing.get(key),
      put: (key, value) => {
        if (key === "device-key.probe") throw new Error("QuotaExceededError");
        return backing.put(key, value);
      },
    };
    await expect(loadDeviceKey(storage, globalThis.crypto.subtle)).rejects.toThrow("QuotaExceededError");
  });

  test("a failed load is retried on the next call", async () => {
    const backing = memoryStore();
    let failing = true;
    const storage: KeyValueStore = {
      get: async (key) => {
        if (failing) throw new Error("IndexedDB is busy");
        return backing.get(key);
      },
      put: (key, value) => backing.put(key, value),
    };
    await expect(loadDeviceKey(storage, null)).rejects.toThrow("IndexedDB is busy");
    failing = false;
    expect((await loadDeviceKey(storage, null)).kind).toBe("raw");
  });

  test("concurrent first calls share one identity", async () => {
    const storage = memoryStore();
    const [first, second] = await Promise.all([loadDeviceKey(storage, null), loadDeviceKey(storage, null)]);
    expect(second.publicKey).toEqual(first.publicKey);
    expect((await loadDeviceKey(storage, null)).publicKey).toEqual(first.publicKey);
  });

  test("with WebCrypto X25519 the private key is a non-extractable CryptoKey", async () => {
    const storage = memoryStore();
    const key = await loadDeviceKey(storage, crypto.subtle);
    expect(key.kind).toBe("webcrypto");
    const stored = await storage.get("device-key");
    expect(stored).toMatchObject({ kind: "webcrypto" });
    const privateKey: unknown = Reflect.get(Object(stored), "privateKey");
    expect(privateKey instanceof CryptoKey && privateKey.extractable).toBe(false);
    const peerPrivate = x25519.utils.randomSecretKey();
    expect(await key.dh(x25519.getPublicKey(peerPrivate))).toEqual(x25519.getSharedSecret(peerPrivate, key.publicKey));
  });
});
