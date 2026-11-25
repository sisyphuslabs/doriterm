import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateSecretKey, recipientOf, unseal } from "typevault/core";

/** Electron's safeStorage as this module uses it: Keychain on macOS, DPAPI on Windows, Secret Service on Linux. */
export interface KeyStore {
  available(): boolean;
  /** `basic_text` (Linux, no keyring) encrypts with a constant key: it protects nothing. */
  backend(): string;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

export interface DesktopVaultKey {
  readonly recipient: string;
  readonly protection: "os-keystore";
  unseal(sealed: Uint8Array): Promise<Uint8Array>;
}

const FILE = "vault-key";

/**
 * This computer's vault key: an age X25519 identity, on disk only as OS key store ciphertext (owner-only file), opened
 * once per launch into this process's memory and never handed to the page. A copy of the file without this user's
 * login (Keychain, DPAPI) opens nothing. Without a real OS key store (none, or Linux's constant-key `basic_text`) it
 * refuses rather than write the key in the clear.
 */
export async function openVaultKey(dir: string, store: KeyStore): Promise<DesktopVaultKey> {
  if (!store.available() || store.backend() === "basic_text")
    throw new Error("no OS key store is available to hold the vault key");
  const path = join(dir, FILE);
  let identity: string;
  if (existsSync(path)) {
    try {
      identity = store.decrypt(readFileSync(path));
    } catch (cause) {
      throw new Error("cannot open the vault key with this computer's key store", { cause });
    }
    if (!identity.startsWith("AGE-SECRET-KEY-1")) throw new Error("cannot open the vault key: it is not an age key");
  } else {
    ({ identity } = await generateSecretKey({ kind: "member", name: "vault" }));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(`${path}.tmp`, store.encrypt(identity), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
  return {
    recipient: await recipientOf(identity),
    protection: "os-keystore",
    unseal: (sealed) => unseal([identity], sealed),
  };
}
