import { base64urlEncode, concatBytes } from "@doriface/crypto";
import { sha256 } from "@noble/hashes/sha2.js";

const encoder = new TextEncoder();
const utf8 = (value: string): Uint8Array<ArrayBuffer> => encoder.encode(value);

export interface RestoreEpoch {
  readonly epoch: number;
  readonly r_e: Uint8Array;
}

export const prfSalt = (): Uint8Array<ArrayBuffer> => Uint8Array.from(sha256(utf8("doriterm prf v1")));

export function u64(value: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("invalid restore version or epoch");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

function params(label: string, ...binding: Uint8Array[]): HkdfParams {
  return {
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(0),
    info: Uint8Array.from(concatBytes(utf8(label), ...binding)),
  };
}

async function material(p0: Uint8Array, epoch?: RestoreEpoch): Promise<CryptoKey> {
  if (p0.byteLength !== 32 || (epoch !== undefined && epoch.r_e.byteLength !== 32))
    throw new RangeError("restore keys require 32-byte PRF output and epoch secret");
  const bytes = epoch === undefined ? Uint8Array.from(p0) : Uint8Array.from(concatBytes(p0, epoch.r_e));
  try {
    return await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey", "deriveBits"]);
  } finally {
    bytes.fill(0);
  }
}

const aes = { name: "AES-GCM", length: 256 } as const;
const uses = ["encrypt", "decrypt"] satisfies KeyUsage[];

export async function locatorKey(p0: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(params("doriterm locator v1"), await material(p0), aes, false, uses);
}

export async function wrappingKey(p0: Uint8Array, epoch: RestoreEpoch): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    params("doriterm wrap v1", u64(epoch.epoch)),
    await material(p0, epoch),
    aes,
    false,
    uses,
  );
}

export async function lookupFor(p0: Uint8Array, epoch: RestoreEpoch, hostId: string): Promise<string> {
  const hkdf = params("doriterm lookup v1", utf8(hostId), u64(epoch.epoch));
  return base64urlEncode(new Uint8Array(await crypto.subtle.deriveBits(hkdf, await material(p0, epoch), 256)));
}
