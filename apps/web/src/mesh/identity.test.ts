import { hostIdOf } from "@doriface/crypto";
import { describe, expect, test } from "bun:test";
import { memoryStore } from "../storage/idb.ts";
import { clientIdOf, loadSignKey, memberIdentityOf } from "./identity.ts";
import { meshNameOf } from "./member-name.ts";

describe("the browser's member identity", () => {
  test("the signing key is created once and read back the same on every later load", async () => {
    const storage = memoryStore();
    const [first, second] = await Promise.all([loadSignKey(storage), loadSignKey(storage)]);
    const again = await loadSignKey(storage);
    expect(first.publicKey).toEqual(second.publicKey);
    expect(again.publicKey).toEqual(first.publicKey);
    expect(first.secretKey).toHaveLength(32);
  });

  test("two browsers never share a key", async () => {
    const [a, b] = await Promise.all([loadSignKey(memoryStore()), loadSignKey(memoryStore())]);
    expect(a.publicKey).not.toEqual(b.publicKey);
  });

  test("a stored value that is not a key is replaced rather than used", async () => {
    const storage = memoryStore();
    await storage.put("mesh-sign-key", { kind: "ed25519", secretKey: "not bytes" });
    const pair = await loadSignKey(storage);
    expect(pair.secretKey).toBeInstanceOf(Uint8Array);
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
