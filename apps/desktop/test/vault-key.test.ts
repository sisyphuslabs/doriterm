import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seal } from "typevault/core";
import { openVaultKey, type KeyStore } from "../src/main/vault-key.ts";

/** An OS key store stand-in: encrypts with a key that exists only in this object, as Keychain/DPAPI hold theirs. */
function osStore(backend = "keychain"): KeyStore & { readonly wipe: () => void } {
  let secret = crypto.getRandomValues(new Uint8Array(32));
  const xor = (bytes: Uint8Array) => bytes.map((byte, at) => byte ^ (secret[at % secret.length] ?? 0));
  return {
    available: () => true,
    backend: () => backend,
    encrypt: (text) => Buffer.concat([Buffer.from("OSv1"), Buffer.from(xor(new TextEncoder().encode(text)))]),
    decrypt: (data) => {
      if (data.subarray(0, 4).toString() !== "OSv1") throw new Error("not this store's ciphertext");
      return new TextDecoder().decode(xor(new Uint8Array(data.subarray(4))));
    },
    wipe: () => {
      secret = crypto.getRandomValues(new Uint8Array(32));
    },
  };
}

const message = new TextEncoder().encode("tier key");
const dir = () => mkdtempSync(join(tmpdir(), "vault-key-"));

describe("the desktop vault key", () => {
  test("is written only as OS key store ciphertext, owner-only, and opens what is sealed to it across launches", async () => {
    const at = dir();
    const store = osStore();
    const key = await openVaultKey(at, store);
    expect(key.protection).toBe("os-keystore");
    const file = readFileSync(join(at, "vault-key"));
    expect(file.toString()).not.toContain("AGE-SECRET-KEY");
    if (process.platform !== "win32") expect(statSync(join(at, "vault-key")).mode & 0o077).toBe(0);

    const relaunched = await openVaultKey(at, store);
    expect(relaunched.recipient).toBe(key.recipient);
    expect(await relaunched.unseal(await seal([key.recipient], message))).toEqual(message);
  });

  test("the key file copied without the OS key store opens nothing", async () => {
    const at = dir();
    const store = osStore();
    await openVaultKey(at, store);
    store.wipe();
    await expect(openVaultKey(at, store)).rejects.toThrow("cannot open the vault key");
  });

  test("Linux without a keyring (basic_text, a constant key) is refused like no key store at all", async () => {
    const at = dir();
    await expect(openVaultKey(at, osStore("basic_text"))).rejects.toThrow("no OS key store");
    expect(existsSync(join(at, "vault-key"))).toBe(false);
  });

  test("with no OS key store at all it refuses instead of writing the key in the clear", async () => {
    const none: KeyStore = { ...osStore(), available: () => false };
    await expect(openVaultKey(dir(), none)).rejects.toThrow("no OS key store");
  });
});
