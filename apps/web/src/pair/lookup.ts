import { isPairSlotExpiry, PAIR_SLOT_SIGNATURE_BYTES } from "@doriface/relay-client/wire";
import { type PairSlotRecord, pairSlotRefusal, pairSlotVerdict } from "@doriface/relay-client";
import { slotOf } from "./code.ts";
import { fromBase64Url, offerFrom, type PairingParse } from "./fragment.ts";

/** The relay's HTTP origin for a ws(s) relay URL. */
export function relayHttpOrigin(relayUrl: string): string {
  return relayUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/+$/, "");
}

function field(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null && Object.hasOwn(body, key) ? Reflect.get(body, key) : undefined;
}

/** A client-facing sentence from one of relay-client's lower-case reasons. */
const sentence = (reason: string): string => `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`;

const MALFORMED = "The relay's answer is malformed.";

/** What the relay answered for one slot, before it is checked against a code. */
export type SlotAnswer =
  | { readonly ok: true; readonly record: PairSlotRecord }
  | { readonly ok: false; readonly reason: string };

/**
 * Asks the relay which host holds `slot`. The answer is untrusted: the host's signature over its slot and Noise key
 * (contract v1.9, #22), then the fingerprint check and the CPace pairing handshake authenticate it.
 */
export async function lookupSlot(slot: string, relayUrl: string, signal?: AbortSignal): Promise<SlotAnswer> {
  let response: Response;
  try {
    response = await fetch(`${relayHttpOrigin(relayUrl)}/v1/pair/${slot}`, signal === undefined ? {} : { signal });
  } catch {
    return { ok: false, reason: "The relay cannot be reached. Check the network and try again." };
  }
  if (response.status === 404) return { ok: false, reason: "No host is pairing with this code. It may have expired." };
  if (!response.ok) return { ok: false, reason: `The relay answered ${response.status}. Try a new code.` };
  const body: unknown = await response.json().catch(() => null);
  const hostId = field(body, "hostId");
  const noise = field(body, "noiseStaticPub");
  const sign = field(body, "signPub");
  if (typeof hostId !== "string" || typeof noise !== "string" || typeof sign !== "string") {
    return { ok: false, reason: "The relay's answer is malformed." };
  }
  const noiseStaticPub = fromBase64Url(noise);
  const signPub = fromBase64Url(sign);
  if (noiseStaticPub === null || signPub === null) return { ok: false, reason: MALFORMED };
  const expiresAt = field(body, "expiresAt");
  const sig = field(body, "slotSig");
  const slotSig = typeof sig === "string" ? fromBase64Url(sig) : null;
  // The signed form's two fields come together; one alone, or either out of shape, is a malformed answer.
  const signed = expiresAt !== undefined || sig !== undefined;
  if (signed && (!isPairSlotExpiry(expiresAt) || slotSig?.byteLength !== PAIR_SLOT_SIGNATURE_BYTES)) {
    return { ok: false, reason: MALFORMED };
  }
  const record =
    signed && slotSig !== null && isPairSlotExpiry(expiresAt)
      ? { hostId, noiseStaticPub, signPub, expiresAt, slotSig }
      : { hostId, noiseStaticPub, signPub };
  return { ok: true, record };
}

/** The offer for a whole `code` from its slot's answer, checked now: the answer may have been asked for earlier. */
export function offerFromSlot(answer: SlotAnswer, code: string, relayUrl: string, now = Date.now()): PairingParse {
  if (!answer.ok) return answer;
  const verdict = pairSlotVerdict(answer.record, slotOf(code), now);
  if (verdict !== "signed") return { ok: false, reason: sentence(pairSlotRefusal(verdict)) };
  const { hostId, noiseStaticPub, signPub } = answer.record;
  return offerFrom({ hostId, noiseStaticPub, signPub }, { mode: "code", code }, { relayUrl, target: "device" });
}

/** Looks the host of a whole code up and checks it: the slot's lookup and the offer, in one step. */
export async function lookupCode(code: string, relayUrl: string, signal?: AbortSignal): Promise<PairingParse> {
  return offerFromSlot(await lookupSlot(slotOf(code), relayUrl, signal), code, relayUrl);
}
