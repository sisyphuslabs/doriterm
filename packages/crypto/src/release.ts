import { ed25519 } from "@noble/curves/ed25519.js";

import { RELEASE_PUBLIC_KEYS } from "./release-keys.ts";

export { RELEASE_PUBLIC_KEYS };

const decode = (text: string, length: number): Uint8Array | null => {
  const trimmed = text.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
  const bytes = Uint8Array.fromBase64(trimmed);
  return bytes.length === length ? bytes : null;
};

/** The public key of a 32-byte Ed25519 secret, as RELEASE_PUBLIC_KEYS writes it. */
export const releasePublicKey = (secretKey: Uint8Array): string => ed25519.getPublicKey(secretKey).toBase64();

/** A detached signature file's text: base64 of the 64 signature bytes and a newline. */
export const signRelease = (message: Uint8Array, secretKey: Uint8Array): string =>
  `${ed25519.sign(message, secretKey).toBase64()}\n`;

/** Whether `signature` is one of the trusted keys' signature over exactly `message`; anything malformed is false. */
export function verifyRelease(
  message: Uint8Array,
  signature: string,
  trusted: readonly string[] = RELEASE_PUBLIC_KEYS,
): boolean {
  const sig = decode(signature, 64);
  if (sig === null) return false;
  return trusted.some((key) => {
    const publicKey = decode(key, 32);
    if (publicKey === null) return false;
    try {
      return ed25519.verify(sig, message, publicKey);
    } catch (error) {
      if (error instanceof Error) return false;
      throw error;
    }
  });
}

/** A secret key as the signing environment holds it: base64 of the 32-byte Ed25519 seed. */
export function parseReleaseSecret(text: string): Uint8Array {
  const secret = decode(text, 32);
  if (secret === null) throw new Error("the release signing key is not base64 of 32 bytes");
  return secret;
}
