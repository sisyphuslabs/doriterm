import { ed25519 } from "@noble/curves/ed25519.js";
import { base64urlEncode } from "@doriface/crypto";
import type { KeyValueStore } from "../storage/idb.ts";

export interface CardKey {
  readonly publicKey: Uint8Array;
  readonly kind: "webcrypto" | "raw";
  sign(message: Uint8Array): Promise<Uint8Array>;
}

type Stored =
  | { readonly kind: "raw"; readonly privateKey: Uint8Array }
  | { readonly kind: "webcrypto"; readonly privateKey: CryptoKey; readonly publicKey: Uint8Array };

export function storedKey(value: unknown): value is Stored {
  if (typeof value !== "object" || value === null) return false;
  const kind: unknown = Reflect.get(value, "kind");
  const privateKey: unknown = Reflect.get(value, "privateKey");
  return kind === "raw"
    ? privateKey instanceof Uint8Array && privateKey.length === 32
    : kind === "webcrypto" && privateKey instanceof CryptoKey && Reflect.get(value, "publicKey") instanceof Uint8Array;
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
    sign: async (message) => new Uint8Array(await subtle.sign("Ed25519", stored.privateKey, Uint8Array.from(message))),
  };
}

async function generate(subtle: SubtleCrypto, secretKey?: Uint8Array): Promise<Stored | undefined> {
  let pair: CryptoKey | CryptoKeyPair;
  try {
    if (secretKey !== undefined) {
      const publicKey = ed25519.getPublicKey(secretKey);
      const privateKey = await subtle.importKey(
        "jwk",
        {
          kty: "OKP",
          crv: "Ed25519",
          x: base64urlEncode(publicKey),
          d: base64urlEncode(secretKey),
        },
        "Ed25519",
        false,
        ["sign"],
      );
      return { kind: "webcrypto", privateKey, publicKey };
    }
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
  const held = await storage.get("mesh-sign-key");
  if (storedKey(held) && held.kind === "webcrypto") return usable(held, subtle);
  let seed = storedKey(held) && held.kind === "raw" ? held.privateKey : undefined;
  // Keep the signing identity created by the first browser join release.
  if (typeof held === "object" && held !== null && Reflect.get(held, "kind") === "ed25519") {
    const secretKey: unknown = Reflect.get(held, "secretKey");
    if (secretKey instanceof Uint8Array && secretKey.length === 32) {
      seed = secretKey;
    }
  }
  if (subtle !== null) {
    const candidate = await generate(subtle, seed);
    if (candidate !== undefined) {
      await storage.put("mesh-sign-key.probe", candidate);
      const back = await storage.get("mesh-sign-key.probe");
      await storage.put("mesh-sign-key.probe", null);
      if (storedKey(back) && back.kind === "webcrypto") {
        await storage.put("mesh-sign-key", candidate);
        return usable(candidate, subtle);
      }
    }
  }
  const raw: Stored = { kind: "raw", privateKey: seed ?? ed25519.utils.randomSecretKey() };
  await storage.put("mesh-sign-key", raw);
  return usable(raw, subtle);
}
