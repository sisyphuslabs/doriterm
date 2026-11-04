import { SIGNATURE_BYTES } from "./identity.ts";
import { MUX_HEADER_BYTES, MuxType, muxHeader } from "./mux.ts";
import { PAIR_SLOT_LENGTH, PAIR_SLOT_PATTERN } from "./pair-code.ts";

/**
 * PAIR_SLOT (type 4, host -> relay): `slot (3 ASCII) || noiseStaticPub (32)`, or since contract v1.8 the signed form
 * `slot || noiseStaticPub || expiresAt (u64 BE) || signature (64)`, or empty to clear the host's slot; the relay knows
 * signPub from the challenge. PAIR_SLOT_ACK (type 5, relay -> host): `status u8 || slot (3 ASCII)`.
 */
export const NOISE_STATIC_PUB_BYTES = 32;
/** Prefix of the statement a host signs for its slot; distinct from the uplink, pass-proof and mesh prefixes. */
export const PAIR_SLOT_CONTEXT = "doriface-pair-slot-v1";
const EXPIRES_AT_BYTES = 8;
const UNSIGNED_BYTES = PAIR_SLOT_LENGTH + NOISE_STATIC_PUB_BYTES;
export const SIGNED_PAIR_SLOT_BYTES = UNSIGNED_BYTES + EXPIRES_AT_BYTES + SIGNATURE_BYTES;

/** The host's signature over its slot's statement, with the offer expiry it covers. */
export interface PairSlotSignature {
  /** The offer's expiry, milliseconds since the epoch. */
  readonly expiresAt: number;
  readonly signature: Uint8Array;
}

export interface PairSlotRequest {
  readonly slot: string;
  readonly noiseStaticPub: Uint8Array;
  /** Absent for the unsigned 35-byte form a host older than contract v1.8 sends. */
  readonly signed?: PairSlotSignature;
}
export const PairSlotAckStatus = { Registered: 0, Taken: 1, Malformed: 2 } as const;
export type PairSlotAckStatus = (typeof PairSlotAckStatus)[keyof typeof PairSlotAckStatus];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function checkedSlot(slot: string): Uint8Array {
  if (!PAIR_SLOT_PATTERN.test(slot)) throw new RangeError(`${JSON.stringify(slot)} is not a pairing slot`);
  return encoder.encode(slot);
}

/** The pairing slot spelled by the first 3 bytes of `bytes`, if they spell one. */
export function slotOf(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength < PAIR_SLOT_LENGTH) return undefined;
  const slot = decoder.decode(bytes.subarray(0, PAIR_SLOT_LENGTH));
  return PAIR_SLOT_PATTERN.test(slot) ? slot : undefined;
}

export function encodePairSlotRequest(slot: string, noiseStaticPub: Uint8Array): Uint8Array<ArrayBuffer> {
  if (noiseStaticPub.byteLength !== NOISE_STATIC_PUB_BYTES) throw new RangeError("noiseStaticPub must be 32 bytes");
  const out = muxHeader(MuxType.PairSlot, 0, PAIR_SLOT_LENGTH + NOISE_STATIC_PUB_BYTES);
  out.set(checkedSlot(slot), MUX_HEADER_BYTES);
  out.set(noiseStaticPub, MUX_HEADER_BYTES + PAIR_SLOT_LENGTH);
  return out;
}

function checkedExpiresAt(expiresAt: number): number {
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0)
    throw new RangeError("expiresAt must be a non-negative integer");
  return expiresAt;
}

/** `"doriface-pair-slot-v1" || slot || noiseStaticPub || expiresAt (u64 BE)`: what the host's signing key signs. */
export function pairSlotStatement(
  slot: string,
  noiseStaticPub: Uint8Array,
  expiresAt: number,
): Uint8Array<ArrayBuffer> {
  if (noiseStaticPub.byteLength !== NOISE_STATIC_PUB_BYTES) throw new RangeError("noiseStaticPub must be 32 bytes");
  const prefix = encoder.encode(PAIR_SLOT_CONTEXT);
  const out = new Uint8Array(prefix.byteLength + UNSIGNED_BYTES + EXPIRES_AT_BYTES);
  out.set(prefix, 0);
  out.set(checkedSlot(slot), prefix.byteLength);
  out.set(noiseStaticPub, prefix.byteLength + PAIR_SLOT_LENGTH);
  new DataView(out.buffer).setBigUint64(prefix.byteLength + UNSIGNED_BYTES, BigInt(checkedExpiresAt(expiresAt)));
  return out;
}

export function encodeSignedPairSlotRequest(
  slot: string,
  noiseStaticPub: Uint8Array,
  { expiresAt, signature }: PairSlotSignature,
): Uint8Array<ArrayBuffer> {
  if (noiseStaticPub.byteLength !== NOISE_STATIC_PUB_BYTES) throw new RangeError("noiseStaticPub must be 32 bytes");
  if (signature.byteLength !== SIGNATURE_BYTES) throw new RangeError("a slot signature is 64 bytes");
  const out = muxHeader(MuxType.PairSlot, 0, SIGNED_PAIR_SLOT_BYTES);
  const at = MUX_HEADER_BYTES;
  out.set(checkedSlot(slot), at);
  out.set(noiseStaticPub, at + PAIR_SLOT_LENGTH);
  new DataView(out.buffer).setBigUint64(at + UNSIGNED_BYTES, BigInt(checkedExpiresAt(expiresAt)));
  out.set(signature, at + UNSIGNED_BYTES + EXPIRES_AT_BYTES);
  return out;
}

export function encodePairSlotClear(): Uint8Array<ArrayBuffer> {
  return muxHeader(MuxType.PairSlot, 0, 0);
}

/** Either PAIR_SLOT form; undefined for any other length or a payload that does not start with a slot. */
export function decodePairSlotRequest(payload: Uint8Array): PairSlotRequest | undefined {
  const slot = slotOf(payload);
  if (slot === undefined) return undefined;
  const noiseStaticPub = payload.slice(PAIR_SLOT_LENGTH, UNSIGNED_BYTES);
  if (payload.byteLength === UNSIGNED_BYTES) return { slot, noiseStaticPub };
  if (payload.byteLength !== SIGNED_PAIR_SLOT_BYTES) return undefined;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const expiresAt = Number(view.getBigUint64(UNSIGNED_BYTES));
  if (!Number.isSafeInteger(expiresAt)) return undefined;
  const signature = payload.slice(UNSIGNED_BYTES + EXPIRES_AT_BYTES);
  return { slot, noiseStaticPub, signed: { expiresAt, signature } };
}

export function encodePairSlotAck(slot: string, status: PairSlotAckStatus): Uint8Array<ArrayBuffer> {
  const out = muxHeader(MuxType.PairSlotAck, 0, 1 + PAIR_SLOT_LENGTH);
  out[MUX_HEADER_BYTES] = status;
  out.set(checkedSlot(slot), MUX_HEADER_BYTES + 1);
  return out;
}

export function decodePairSlotAck(
  payload: Uint8Array,
): { readonly slot: string; readonly status: PairSlotAckStatus } | undefined {
  if (payload.byteLength !== 1 + PAIR_SLOT_LENGTH) return undefined;
  const slot = slotOf(payload.subarray(1));
  const status = payload[0];
  const known =
    status === PairSlotAckStatus.Registered ||
    status === PairSlotAckStatus.Taken ||
    status === PairSlotAckStatus.Malformed
      ? status
      : undefined;
  return slot === undefined || known === undefined ? undefined : { slot, status: known };
}
