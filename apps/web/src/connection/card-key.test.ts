import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, test } from "bun:test";
import { memoryStore, type KeyValueStore } from "../storage/idb.ts";
import { readOrCreateCardKey } from "./card-key.ts";

describe("readOrCreateCardKey", () => {
  test("a store that refuses to clone a CryptoKey keeps raw bytes instead (#1634)", async () => {
    const backing = memoryStore();
    const refusing = (): KeyValueStore => ({
      get: (key) => backing.get(key),
      put: (key, value) => {
        const privateKey: unknown = Reflect.get(Object(value), "privateKey");
        if (privateKey instanceof CryptoKey) throw new DOMException("The object can not be cloned.", "DataCloneError");
        return backing.put(key, value);
      },
    });
    const first = await readOrCreateCardKey(refusing(), globalThis.crypto.subtle);
    expect(first.kind).toBe("raw");
    expect(await backing.get("mesh-sign-key")).toMatchObject({ kind: "raw" });
    const message = new TextEncoder().encode("client card");
    expect(ed25519.verify(await first.sign(message), message, first.publicKey)).toBe(true);
    const afterReload = await readOrCreateCardKey(refusing(), globalThis.crypto.subtle);
    expect(afterReload.publicKey).toEqual(first.publicKey);
  });
});
