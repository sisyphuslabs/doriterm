import { base64urlEncode } from "@doriface/crypto";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const COMMIT = utf8ToBytes("doriface/1.3 join commit");
const CODE = utf8ToBytes("doriface/1.3 mesh join code");

/** CLEAR section 9: the inviter commits before learning the joiner's random contribution. */
export function joinCommit(h: Uint8Array, Ni: Uint8Array): string {
  return base64urlEncode(sha256(concatBytes(COMMIT, h, Ni)));
}

/** The six decimal digits both people compare on a screen or over a call, grouped for reading. */
export function joinCode(h: Uint8Array, Ni: Uint8Array, Nj: Uint8Array): string {
  const bytes = hkdf(sha256, concatBytes(h, Ni, Nj), new Uint8Array(), CODE, 4);
  const digits = String(
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0) % 1_000_000,
  ).padStart(6, "0");
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}
