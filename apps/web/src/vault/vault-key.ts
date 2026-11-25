import type { DeviceKey } from "@doriface/vault";
import { generateSecretKey, recipientOf, unseal } from "typevault/core";
import { keepsStoredKeys } from "../connection/device-key.ts";
import type { KeyValueStore } from "../storage/idb.ts";

const KEY = "vault-key";
const ALGORITHM = { name: "X25519" } as const;

type StoredWebCrypto = { readonly kind: "webcrypto"; readonly privateKey: CryptoKey };
/** Only where this browser's storage cannot keep a CryptoKey (WebKit, #1329/#1634): an age identity string. */
type StoredText = { readonly kind: "text"; readonly identity: string };

function storedOf(value: unknown): StoredWebCrypto | StoredText | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const kind: unknown = Reflect.get(value, "kind");
  const privateKey: unknown = Reflect.get(value, "privateKey");
  const identity: unknown = Reflect.get(value, "identity");
  if (kind === "webcrypto" && privateKey instanceof CryptoKey) return { kind, privateKey };
  if (kind === "text" && typeof identity === "string" && identity.startsWith("AGE-SECRET-KEY-1"))
    return { kind, identity };
  return undefined;
}

async function deviceKeyOf(stored: StoredWebCrypto | StoredText): Promise<DeviceKey> {
  const identity = stored.kind === "webcrypto" ? stored.privateKey : stored.identity;
  return {
    recipient: await recipientOf(identity),
    protection: stored.kind === "webcrypto" ? "non-extractable" : "unprotected",
    unseal: (sealed) => unseal([identity], sealed),
  };
}

async function create(storage: KeyValueStore, subtle: SubtleCrypto | null): Promise<StoredWebCrypto | StoredText> {
  if (subtle !== null && (await keepsStoredKeys(storage, subtle))) {
    const pair = await subtle.generateKey(ALGORITHM, false, ["deriveBits"]);
    if ("privateKey" in pair) {
      const stored: StoredWebCrypto = { kind: "webcrypto", privateKey: pair.privateKey };
      await storage.put(KEY, stored);
      return stored;
    }
  }
  const { identity } = await generateSecretKey({ kind: "member", name: "vault" });
  const stored: StoredText = { kind: "text", identity };
  await storage.put(KEY, stored);
  return stored;
}

/**
 * This browser's vault key: a non-extractable X25519 CryptoKey in IndexedDB, generated on first use, so script can use
 * it but never read it. It is loaded only in the vault worker, with the tier keys it opens (vault-worker.ts). It is a key apart from the
 * device's Noise key: a vault key may be replaced without re-pairing, and the Noise key never decrypts stored data.
 */
export async function loadVaultKey(storage: KeyValueStore, subtle: SubtleCrypto | null): Promise<DeviceKey> {
  const held = storedOf(await storage.get(KEY));
  return deviceKeyOf(held ?? (await create(storage, subtle)));
}
