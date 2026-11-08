import { ed25519 } from "@noble/curves/ed25519.js";
import type { KeyValueStore } from "../storage/idb.ts";

export interface CardKey {
  readonly publicKey: Uint8Array;
  readonly kind: "webcrypto" | "raw";
  sign(message: Uint8Array): Promise<Uint8Array>;
}

type Stored =
  | { readonly kind: "raw"; readonly privateKey: Uint8Array }
  | { readonly kind: "webcrypto"; readonly privateKey: CryptoKey; readonly publicKey: Uint8Array };

function storedKey(value: unknown): value is Stored {
  if (typeof value !== "object" || value === null) return false;
  const kind: unknown = Reflect.get(value, "kind");
  const privateKey: unknown = Reflect.get(value, "privateKey");
  return kind === "raw"
    ? privateKey instanceof Uint8Array && privateKey.length === 32
    : kind === "webcrypto" &&
        privateKey instanceof CryptoKey &&
        Reflect.get(value, "publicKey") instanceof Uint8Array;
}

function usable(stored: Stored, subtle: SubtleCrypto | null): CardKey {
  if (stored.kind === "raw") {
    return {
      kind: "raw",
      publicKey: ed25519.getPublicKey(stored.privateKey),
      sign: async (message) => ed25519.sign(message, stored.privateKey),
    };
  }
  if (subtle === null) throw new Error("The saved card key needs WebCrypto Ed25519.");
  return {
    kind: "webcrypto",
    publicKey: stored.publicKey,
    sign: async (message) =>
      new Uint8Array(await subtle.sign("Ed25519", stored.privateKey, Uint8Array.from(message))),
  };
}

async function generate(subtle: SubtleCrypto): Promise<Stored | undefined> {
  let pair: CryptoKey | CryptoKeyPair;
  try {
    pair = await subtle.generateKey("Ed25519", false, ["sign", "verify"]);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotSupportedError") return undefined;
    throw error;
  }
  if (!("privateKey" in pair)) throw new Error("Ed25519 generateKey returned no key pair");
  return {
    kind: "webcrypto",
    privateKey: pair.privateKey,
    publicKey: new Uint8Array(await subtle.exportKey("raw", pair.publicKey)),
  };
}

/** Called while the device identity's Web Lock is held. Storage failures never downgrade custody. */
export async function readOrCreateCardKey(storage: KeyValueStore, subtle: SubtleCrypto | null): Promise<CardKey> {
  const held = await storage.get("card-key");
  if (storedKey(held)) return usable(held, subtle);
  if (subtle !== null) {
    const candidate = await generate(subtle);
    if (candidate !== undefined) {
      await storage.put("card-key.probe", candidate);
      const back = await storage.get("card-key.probe");
      await storage.put("card-key.probe", null);
      if (storedKey(back) && back.kind === "webcrypto") {
        await storage.put("card-key", candidate);
        return usable(candidate, subtle);
      }
    }
  }
  const raw: Stored = { kind: "raw", privateKey: ed25519.utils.randomSecretKey() };
  await storage.put("card-key", raw);
  return usable(raw, subtle);
}
