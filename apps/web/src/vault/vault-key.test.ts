import { describe, expect, test } from "bun:test";
import { seal } from "typevault/core";
import { memoryStore, type KeyValueStore } from "../storage/idb.ts";
import { loadVaultKey } from "./vault-key.ts";

const message = new TextEncoder().encode("tier key");

describe("the browser's vault key", () => {
  test("is a non-extractable CryptoKey kept across loads, and opens what is sealed to its recipient", async () => {
    const storage = memoryStore();
    const key = await loadVaultKey(storage, globalThis.crypto.subtle);
    expect(key.protection).toBe("non-extractable");
    const stored: unknown = await storage.get("vault-key");
    const privateKey: unknown = Reflect.get(Object(stored), "privateKey");
    expect(privateKey instanceof CryptoKey && privateKey.extractable).toBe(false);

    const again = await loadVaultKey(storage, globalThis.crypto.subtle);
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
    const key = await loadVaultKey(refusing, globalThis.crypto.subtle);
    expect(key.protection).toBe("unprotected");
    const again = await loadVaultKey(refusing, globalThis.crypto.subtle);
    expect(again.recipient).toBe(key.recipient);
    expect(await again.unseal(await seal([key.recipient], message))).toEqual(message);
  });
});
