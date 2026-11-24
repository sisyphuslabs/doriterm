import { describe, expect, test } from "bun:test";
import { seal } from "typevault/core";
import { memoryStore, type KeyValueStore } from "../storage/idb.ts";
import { loadVaultKey, type VaultKeyBridge } from "./vault-key.ts";

const message = new TextEncoder().encode("tier key");

describe("the browser's vault key", () => {
  test("is a non-extractable CryptoKey kept across loads, and opens what is sealed to its recipient", async () => {
    const storage = memoryStore();
    const key = await loadVaultKey(storage, globalThis.crypto.subtle, null);
    expect(key.protection).toBe("non-extractable");
    const stored: unknown = await storage.get("vault-key");
    const privateKey: unknown = Reflect.get(Object(stored), "privateKey");
    expect(privateKey instanceof CryptoKey && privateKey.extractable).toBe(false);

    const again = await loadVaultKey(storage, globalThis.crypto.subtle, null);
    expect(again.recipient).toBe(key.recipient);
    expect(await again.unseal(await seal([key.recipient], message))).toEqual(message);
  });

  test("a store that refuses to clone a CryptoKey keeps the identity as text and says it is unprotected", async () => {
    const backing = memoryStore();
    const refusing: KeyValueStore = {
      get: (name) => backing.get(name),
      put: (name, value) => {
        if (Reflect.get(Object(value), "privateKey") instanceof CryptoKey)
          throw new DOMException("The object can not be cloned.", "DataCloneError");
        return backing.put(name, value);
      },
    };
    const key = await loadVaultKey(refusing, globalThis.crypto.subtle, null);
    expect(key.protection).toBe("unprotected");
    const again = await loadVaultKey(refusing, globalThis.crypto.subtle, null);
    expect(again.recipient).toBe(key.recipient);
    expect(await again.unseal(await seal([key.recipient], message))).toEqual(message);
  });

  test("the desktop app's key is the main process's: nothing is stored in the page", async () => {
    const storage = memoryStore();
    const bridge: VaultKeyBridge = {
      recipient: async () => "age1desktop",
      protection: async () => "os-keystore",
      unseal: async () => message,
    };
    const key = await loadVaultKey(storage, globalThis.crypto.subtle, bridge);
    expect(key.recipient).toBe("age1desktop");
    expect(key.protection).toBe("os-keystore");
    expect(await key.unseal(new Uint8Array())).toEqual(message);
    expect(await storage.get("vault-key")).toBeUndefined();
  });
});
