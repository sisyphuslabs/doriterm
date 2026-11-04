import { checkPairSlotAnswer, type PairSlotRefusal } from "@doriface/relay-client";
import { slotOf } from "./code.ts";
import { offerFrom, type PairingParse } from "./fragment.ts";

/** The relay's HTTP origin for a ws(s) relay URL. */
export function relayHttpOrigin(relayUrl: string): string {
  return relayUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/+$/, "");
}

const REFUSALS: Readonly<Record<PairSlotRefusal, string>> = {
  malformed: "The relay's answer is malformed.",
  unsigned:
    "The host on this code did not sign its pairing key, so the code cannot be trusted. Update doriface-host on that computer, or pair with its link or QR code.",
  forged:
    "The relay answered with a key this host did not sign. Do not pair with this code; use the host's link or QR code.",
  expired: "This code's offer has expired. Check this device's clock, or open a new code on the host.",
};

/**
 * Asks the relay which host holds this code's slot. The answer counts only once the host's own signature vouches for
 * its Noise key on this slot (contract v1.8); the fingerprint check and the CPace handshake still follow.
 */
export async function lookupCode(code: string, relayUrl: string, signal?: AbortSignal): Promise<PairingParse> {
  let response: Response;
  try {
    response = await fetch(
      `${relayHttpOrigin(relayUrl)}/v1/pair/${slotOf(code)}`,
      signal === undefined ? {} : { signal },
    );
  } catch {
    return { ok: false, reason: "The relay cannot be reached. Check the network and try again." };
  }
  if (response.status === 404) return { ok: false, reason: "No host is pairing with this code. It may have expired." };
  if (!response.ok) return { ok: false, reason: `The relay answered ${response.status}. Try a new code.` };
  const body: unknown = await response.json().catch(() => null);
  const answer = await checkPairSlotAnswer(body, slotOf(code), Date.now());
  if (!answer.ok) return { ok: false, reason: REFUSALS[answer.reason] };
  return offerFrom(answer.record, { mode: "code", code }, relayUrl);
}
