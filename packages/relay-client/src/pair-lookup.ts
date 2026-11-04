import { checkPairSlotAnswer, type PairSlotRecord, type PairSlotRefusal } from "./pair-answer.ts";
import { normalizePairCode, pairSlotOf } from "./wire/index.ts";

export type { PairSlotRecord } from "./pair-answer.ts";

export class PairLookupError extends Error {
  override readonly name = "PairLookupError";
  readonly status: number;

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}

export interface PairLookupOptions {
  /** e.g. `https://relay-doriface.omo.dev`. */
  readonly relayUrl: string;
  /** The code as typed, e.g. `ab3k 9xqz`; only its slot is sent. */
  readonly code: string;
  /** Cancels the lookup, e.g. when the person leaves the pairing screen. */
  readonly signal?: AbortSignal;
  readonly fetch?: (url: string, init?: { readonly signal?: AbortSignal }) => Promise<Response>;
}

/** The relay is often configured by its WebSocket URL; the lookup is plain HTTP(S) on the same host. */
function httpUrl(relayUrl: string): string {
  return relayUrl.replace(/^ws(s?):\/\//i, "http$1://");
}

async function jsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new PairLookupError(502, "the relay's pairing answer is not JSON", { cause: error });
  }
}

const REFUSALS: Readonly<Record<PairSlotRefusal, string>> = {
  malformed: "the relay's pairing answer is malformed",
  unsigned:
    "the host on this code did not sign its pairing key: update doriface-host there, or pair with its link instead",
  forged: "the relay's pairing answer carries a key the host did not sign: do not pair with this code",
  expired: "the host's signed pairing offer has expired: check this machine's clock, or open a new code on the host",
};

/**
 * Finds the host pairing on a typed code's slot. Undefined when no host holds the slot; throws PairLookupError for
 * a malformed code, a rate limit (429), or an answer that does not parse, whose signPub does not hash to hostId, or
 * whose Noise key the host did not sign for this slot (502).
 */
export async function lookupPairSlot(options: PairLookupOptions): Promise<PairSlotRecord | undefined> {
  const code = normalizePairCode(options.code);
  if (code === undefined) throw new PairLookupError(400, "a pairing code is 8 characters from 0-9 and A-Z");
  const url = new URL(`/v1/pair/${pairSlotOf(code)}`, httpUrl(options.relayUrl)).toString();
  const init = options.signal === undefined ? {} : { signal: options.signal };
  const response = await (options.fetch ?? fetch)(url, init);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new PairLookupError(response.status, `pairing lookup failed with HTTP ${response.status}`);
  const answer = await checkPairSlotAnswer(await jsonBody(response), pairSlotOf(code), Date.now());
  if (!answer.ok) throw new PairLookupError(502, REFUSALS[answer.reason]);
  return answer.record;
}
