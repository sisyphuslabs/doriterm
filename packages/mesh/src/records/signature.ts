import { base64urlDecode, base64urlEncode, concatBytes } from "@doriface/crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Signed } from "./types.ts";

const encoder = new TextEncoder();

export const signatureMessage = (prefix: string, body: string): Uint8Array =>
  concatBytes(encoder.encode(prefix), sha256(encoder.encode(body)));

export function signWith(prefix: string, body: string, secret: Uint8Array): Signed {
  return { body, sig: base64urlEncode(ed25519.sign(signatureMessage(prefix, body), secret)) };
}

/** Canonical, unpadded base64url: no alternate spelling of the same key or signature. */
function decodes(value: unknown, bytes: 16 | 32 | 64): value is string {
  if (typeof value !== "string" || value.length !== Math.ceil((4 * bytes) / 3)) return false;
  return /^[A-Za-z0-9_-]*$/.test(value) && base64urlEncode(base64urlDecode(value)) === value;
}

export const isNonce = (value: unknown): value is string => decodes(value, 16);
export const isKey = (value: unknown): value is string => decodes(value, 32);
export const isSignature = (value: unknown): value is string => decodes(value, 64);

export function verifiesWith(prefix: string, signed: Signed, signPub: string): boolean {
  if (!isKey(signPub) || !isSignature(signed.sig)) return false;
  return ed25519.verify(base64urlDecode(signed.sig), signatureMessage(prefix, signed.body), base64urlDecode(signPub));
}
