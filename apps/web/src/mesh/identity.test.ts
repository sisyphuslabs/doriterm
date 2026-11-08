import { hostIdOf } from "@doriface/crypto";
import { describe, expect, test } from "bun:test";
import { memoryStore } from "../storage/idb.ts";
import { clientIdOf, loadSignKey, memberIdentityOf } from "./identity.ts";
import { meshNameOf } from "./member-name.ts";
import { ed25519 } from "@noble/curves/ed25519.js";

describe("the browser's member identity", () => {
  test("upgrading the first browser join release retains its signing identity", async () => {
    const storage = memoryStore();
    const secretKey = ed25519.utils.randomSecretKey();
    await storage.put("mesh-sign-key", { kind: "ed25519", secretKey });
    const sign = await loadSignKey(storage);
    expect(sign.kind).toBe("webcrypto");
    expect(sign.publicKey).toEqual(ed25519.getPublicKey(secretKey));
    const message = new Uint8Array([7, 8, 9]);
    expect(ed25519.verify(await sign.sign(message), message, sign.publicKey)).toBe(true);
  });

  test("new signing keys cannot be exported when IndexedDB preserves CryptoKeys", async () => {
    const storage = memoryStore();
    await loadSignKey(storage);
    const saved = await storage.get("mesh-sign-key");
    const privateKey: unknown = Reflect.get(Object(saved), "privateKey");
    expect(privateKey).toBeInstanceOf(CryptoKey);
    if (!(privateKey instanceof CryptoKey)) throw new Error("signing key was stored as bytes");
    expect(privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", privateKey)).rejects.toThrow();
  });

  test("the signing key is created once and read back the same on every later load", async () => {
    const storage = memoryStore();
    const [first, second] = await Promise.all([loadSignKey(storage), loadSignKey(storage)]);
    const again = await loadSignKey(storage);
    expect(first.publicKey).toEqual(second.publicKey);
    expect(again.publicKey).toEqual(first.publicKey);
    const message = new Uint8Array([1, 2, 3]);
    expect(ed25519.verify(await first.sign(message), message, first.publicKey)).toBe(true);
  });

  test("two browsers never share a key", async () => {
    const [a, b] = await Promise.all([loadSignKey(memoryStore()), loadSignKey(memoryStore())]);
    expect(a.publicKey).not.toEqual(b.publicKey);
  });

  test("a stored value that is not a key is replaced rather than used", async () => {
    const storage = memoryStore();
    await storage.put("mesh-sign-key", { kind: "ed25519", secretKey: "not bytes" });
    const pair = await loadSignKey(storage);
    const message = new Uint8Array([4, 5, 6]);
    expect(ed25519.verify(await pair.sign(message), message, pair.publicKey)).toBe(true);
  });

  test("the hostId is the one every member derives from the signing key", async () => {
    const sign = await loadSignKey(memoryStore());
    const noisePub = new Uint8Array(32).fill(7);
    const identity = memberIdentityOf(sign, noisePub);
    expect(identity.hostId).toBe(hostIdOf(sign.publicKey));
    expect(identity.noisePub).toBe(noisePub);
  });

  test("the client id has a core id's shape, is stable, and differs from the hostId's bytes", async () => {
    const sign = await loadSignKey(memoryStore());
    const id = clientIdOf(sign.publicKey);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(clientIdOf(sign.publicKey)).toBe(id);
    expect(id).not.toBe(hostIdOf(sign.publicKey));
  });
});

describe("the browser's mesh name", () => {
  test.each([
    ["Chrome on macOS", "chrome-on-macos"],
    ["Safari on iOS", "safari-on-ios"],
    ["Firefox", "firefox"],
    ["  Edge on Windows  ", "edge-on-windows"],
    ["---", "browser"],
    ["", "browser"],
    ["t1bcd", "browser"],
    ["Browser".repeat(8), "browserbrowserbrowserbrowserbrow"],
  ])("%j becomes %j", (deviceName, expected) => {
    expect(meshNameOf(deviceName)).toBe(expected);
  });
});
