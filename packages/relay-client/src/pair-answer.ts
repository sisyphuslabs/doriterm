import { ed25519 } from "@noble/curves/ed25519.js";
import {
  fromBase64Url,
  HOST_ID_PATTERN,
  hostIdOf,
  NOISE_STATIC_PUB_BYTES,
  pairSlotStatement,
  SIGN_PUB_BYTES,
  SIGNATURE_BYTES,
} from "./wire/index.ts";

/** How far past its signed expiry a slot answer is still taken, for a client clock that runs ahead (contract v1.8). */
export const PAIR_SLOT_CLOCK_ALLOWANCE_MS = 10 * 60 * 1000;

/** The host on a pairing slot, after its own signature vouched for the Noise key. */
export interface PairSlotRecord {
  readonly hostId: string;
  readonly noiseStaticPub: Uint8Array;
  readonly signPub: Uint8Array;
}

/**
 * Why an answer is refused. `unsigned`: no slot signature, as from a host older than contract v1.8 or a relay that
 * dropped it. `forged`: the signature does not cover this Noise key, slot and expiry. `expired`: it covers an offer
 * that ended more than the clock allowance ago.
 */
export type PairSlotRefusal = "malformed" | "unsigned" | "forged" | "expired";

export type PairSlotAnswer =
  | { readonly ok: true; readonly record: PairSlotRecord }
  | { readonly ok: false; readonly reason: PairSlotRefusal };

function field(body: unknown, name: string): unknown {
  return typeof body === "object" && body !== null ? Object.getOwnPropertyDescriptor(body, name)?.value : undefined;
}

const refuse = (reason: PairSlotRefusal): PairSlotAnswer => ({ ok: false, reason });

async function keysOf(body: unknown): Promise<PairSlotRecord | undefined> {
  const hostId = field(body, "hostId");
  const noise = field(body, "noiseStaticPub");
  const sign = field(body, "signPub");
  if (typeof hostId !== "string" || typeof noise !== "string" || typeof sign !== "string") return undefined;
  const noiseStaticPub = fromBase64Url(noise);
  const signPub = fromBase64Url(sign);
  if (!HOST_ID_PATTERN.test(hostId) || noiseStaticPub?.byteLength !== NOISE_STATIC_PUB_BYTES) return undefined;
  if (signPub?.byteLength !== SIGN_PUB_BYTES || (await hostIdOf(signPub)) !== hostId) return undefined;
  return { hostId, noiseStaticPub, signPub };
}

/**
 * Checks a `GET /v1/pair/<slot>` answer for the slot of the code the person typed: `signPub` must hash to `hostId`,
 * and `slotSig` must be `signPub`'s Ed25519 signature over that slot, the answer's Noise key and its `expiresAt`.
 * Only then is the Noise key the host's; nothing else in the answer is trusted.
 */
export async function checkPairSlotAnswer(body: unknown, slot: string, now: number): Promise<PairSlotAnswer> {
  const record = await keysOf(body);
  if (record === undefined) return refuse("malformed");
  const expiresAt = field(body, "expiresAt");
  const slotSig = field(body, "slotSig");
  if (expiresAt === undefined && slotSig === undefined) return refuse("unsigned");
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt < 0) return refuse("malformed");
  const signature = typeof slotSig === "string" ? fromBase64Url(slotSig) : undefined;
  if (signature?.byteLength !== SIGNATURE_BYTES) return refuse("malformed");
  const statement = pairSlotStatement(slot, record.noiseStaticPub, expiresAt);
  if (!ed25519.verify(signature, statement, record.signPub)) return refuse("forged");
  if (expiresAt + PAIR_SLOT_CLOCK_ALLOWANCE_MS < now) return refuse("expired");
  return { ok: true, record };
}
