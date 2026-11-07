import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, no padding. */
export function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** Unpadded base64url, or null for anything that is not: a stray character, or a length of 1 mod 4. */
export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** hostId = base32(SHA-256(signPub)[0..16]): 26 characters. */
export function hostIdOf(signPub: Uint8Array): string {
  return base32(sha256(signPub).subarray(0, 16));
}

/** The fingerprint people compare: SHA-256(noiseStaticPub)[0..20] as uppercase hex, 10 groups of 4. */
export function fingerprintOf(noiseStaticPub: Uint8Array): string {
  const hex = bytesToHex(sha256(noiseStaticPub).subarray(0, 20)).toUpperCase();
  return hex.match(/.{4}/g)?.join(" ") ?? hex;
}

/** How this offer pairs: the typed code (CPace over `?pair`) or the link secret from a QR/URL (contract v1.3). */
export type OfferSecret =
  | { readonly mode: "code"; readonly code: string }
  | { readonly mode: "link"; readonly linkSecret: Uint8Array };

/** What a link admits: this browser as a device of the host, or a machine joining the host's mesh (`&m=1`). */
export type PairingTarget = "device" | "mesh";

export interface PairingOffer {
  readonly hostId: string;
  readonly noiseStaticPub: Uint8Array;
  readonly signPub: Uint8Array;
  readonly secret: OfferSecret;
  readonly relayUrl: string;
  readonly fingerprint: string;
  readonly target: PairingTarget;
}

export type PairingParse =
  | { readonly ok: true; readonly offer: PairingOffer }
  | { readonly ok: false; readonly reason: string };

const OLDER_HOST = "This pairing link comes from an older doriface-host. Run doriface-host pair again.";

const paramsOf = (hash: string): URLSearchParams => new URLSearchParams(hash.replace(/^#/, ""));

/** What a link says it admits, read from its `m` flag alone, so a link too broken to parse still says it (#727). */
export const linkTarget = (hash: string): PairingTarget => (paramsOf(hash).get("m") === "1" ? "mesh" : "device");

/** Parses `#h=&k=&s=&p=&r=` and checks that hostId belongs to the signing key it came with. */
export function parsePairingFragment(hash: string): PairingParse {
  const params = paramsOf(hash);
  if (!params.has("p") && params.has("c")) return { ok: false, reason: OLDER_HOST };
  const hostId = params.get("h") ?? "";
  const noiseStaticPub = fromBase64Url(params.get("k") ?? "");
  const signPub = fromBase64Url(params.get("s") ?? "");
  const link = params.get("p") ?? "";
  const linkSecret = link.length === 43 ? fromBase64Url(link) : null;
  const relayUrl = params.get("r") ?? "";
  const target = linkTarget(hash);
  if (noiseStaticPub === null || signPub === null) return { ok: false, reason: "The host's keys are missing." };
  if (linkSecret?.byteLength !== 32) return { ok: false, reason: "The pairing link's secret is malformed." };
  if (!/^wss?:\/\//.test(relayUrl)) return { ok: false, reason: "The relay address is not a WebSocket URL." };
  return offerFrom({ hostId, noiseStaticPub, signPub }, { mode: "link", linkSecret }, { relayUrl, target });
}

export interface HostKeys {
  readonly hostId: string;
  readonly noiseStaticPub: Uint8Array;
  readonly signPub: Uint8Array;
}

export interface OfferPlacement {
  readonly relayUrl: string;
  readonly target: PairingTarget;
}

/** Checks that hostId belongs to the signing key, then attaches the fingerprint to show. */
export function offerFrom(keys: HostKeys, secret: OfferSecret, placement: OfferPlacement): PairingParse {
  const { relayUrl, target } = placement;
  if (keys.noiseStaticPub.byteLength !== 32 || keys.signPub.byteLength !== 32) {
    return { ok: false, reason: "The host's keys are malformed." };
  }
  if (hostIdOf(keys.signPub) !== keys.hostId)
    return { ok: false, reason: "The host ID does not match its signing key." };
  return { ok: true, offer: { ...keys, secret, relayUrl, target, fingerprint: fingerprintOf(keys.noiseStaticPub) } };
}
