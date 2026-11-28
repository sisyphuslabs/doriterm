import type { LocalHostEndpoint, PairOffer, PairOfferAnswer, PairOfferRequest } from "../shared/bridge.ts";

/** Long enough for a host that is still opening its offer on the relay, short enough to keep the dialog responsive. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** The loopback gateway answers plain HTTP on the same port as its websocket; the pair routes sit beside /v1/hc. */
export function pairEndpointUrl(endpoint: LocalHostEndpoint): string {
  const url = new URL(endpoint.url);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/v1/pair";
  url.search = "";
  return url.toString();
}

const unavailable = (reason: string): PairOfferAnswer => ({ state: "unavailable", reason });

/**
 * Asks this computer's host for its pairing offer (`open` replaces a pending one; `state` is read-only) over the
 * token-guarded loopback gateway. The host is another process, so every answer is checked before the page sees it, and
 * every failure is a value the dialog can say out loud.
 */
export async function requestPairOffer(
  endpoint: LocalHostEndpoint,
  request: PairOfferRequest,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<PairOfferAnswer> {
  let response: Response;
  try {
    const url = new URL(pairEndpointUrl(endpoint));
    if (request === "open-agent") url.searchParams.set("agent", "1");
    response = await fetch(url, {
      method: request === "state" ? "GET" : "POST",
      headers: { authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
  if (response.status === 404) return unavailable("This doriface-host is too old to offer this computer.");
  if (response.status === 401) return unavailable("This computer's host refused the request; start it again.");
  if (!response.ok) return unavailable(`This computer's host answered ${response.status}.`);
  const body: unknown = await response.json().catch(() => null);
  const answer = pairOfferAnswer(body);
  return answer ?? unavailable("This computer's host sent an answer this app does not understand.");
}

/** A structural check of the host's JSON, so a misbehaving or replaced host cannot put junk in the dialog. */
export function pairOfferAnswer(value: unknown): PairOfferAnswer | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const state: unknown = Reflect.get(value, "state");
  switch (state) {
    case "none":
    case "expired":
    case "approval":
      return { state };
    case "pending": {
      const offer = pairOffer(Reflect.get(value, "offer"));
      return offer === undefined ? undefined : { state, offer };
    }
    case "paired": {
      const device = pairedDevice(Reflect.get(value, "device"));
      return device === false ? undefined : { state, device };
    }
    default:
      return undefined;
  }
}

function pairOffer(value: unknown): Extract<PairOfferAnswer, { state: "pending" }>["offer"] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const code: unknown = Reflect.get(value, "code");
  const link: unknown = Reflect.get(value, "link");
  const opens: unknown = Reflect.get(value, "opens");
  const phoneLink: unknown = Reflect.get(value, "phoneLink");
  const hostId: unknown = Reflect.get(value, "hostId");
  const fingerprint: unknown = Reflect.get(value, "fingerprint");
  const expiresAt: unknown = Reflect.get(value, "expiresAt");
  const slot: unknown = Reflect.get(value, "slot");
  const codeUsable: unknown = Reflect.get(value, "codeUsable");
  if (typeof code !== "string" || typeof link !== "string" || typeof hostId !== "string") return undefined;
  if (typeof fingerprint !== "string" || typeof expiresAt !== "number" || typeof codeUsable !== "boolean")
    return undefined;
  if (opens !== "web" && opens !== "desktop") return undefined;
  if (slot !== "pending" && slot !== "registered" && slot !== "unavailable") return undefined;
  // A host from before #700 sends no phone link; the dialog's QR code then encodes `link`.
  if (phoneLink !== undefined && typeof phoneLink !== "string") return undefined;
  const offer: PairOffer = { code, link, opens, hostId, fingerprint, expiresAt, slot, codeUsable };
  return phoneLink === undefined ? offer : { ...offer, phoneLink };
}

/** `false` refuses the answer; `null` is a device the host did not name (a pairing it cannot attribute). */
function pairedDevice(value: unknown): { name: string; id: string; pairedAt: string } | null | false {
  if (value === null) return null;
  if (typeof value !== "object") return false;
  const name: unknown = Reflect.get(value, "name");
  const id: unknown = Reflect.get(value, "id");
  const pairedAt: unknown = Reflect.get(value, "pairedAt");
  if (typeof name !== "string" || typeof id !== "string" || typeof pairedAt !== "string") return false;
  return { name, id, pairedAt };
}
