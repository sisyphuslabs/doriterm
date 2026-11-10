import { ed25519 } from "@noble/curves/ed25519.js";

/**
 * The Ed25519 keys a Doriterm release is signed with (#1969), base64 of the 32 raw public-key bytes. The release's
 * mirror signs SHA256SUMS.txt and each channel's host manifest with the private half, a GitHub environment secret; the
 * host binary checks a manifest against these before it downloads anything, and install.sh asks the binary it just
 * fetched to check SHA256SUMS.txt. Rotation: a release signed by the old key ships a build that trusts both keys, and
 * the next release is signed with the new key only.
 */
export const RELEASE_PUBLIC_KEYS: readonly string[] = [];

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
