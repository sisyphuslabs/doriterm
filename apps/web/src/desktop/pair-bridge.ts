import { bridgeMethod } from "./bridge.ts";

/** One pairing offer for this computer, as the desktop shell relays it from this computer's host. */
export interface DesktopPairOffer {
  readonly code: string;
  readonly link: string;
  /** What opens `link`: a web page, or the doriface desktop app (`doriface://pair#…`, the default). */
  readonly opens: "web" | "desktop";
  /** What the QR code encodes for a phone, `<web origin>/pair#…`; absent from a host older than #700. */
  readonly phoneLink?: string;
  readonly hostId: string;
  readonly fingerprint: string;
  /** When the offer stops working, in ms since the epoch. */
  readonly expiresAt: number;
  readonly slot: "pending" | "registered" | "unavailable";
  readonly codeUsable: boolean;
}

export interface DesktopPairedDevice {
  readonly name: string;
  readonly id: string;
  readonly pairedAt: string;
}

/** `open` replaces a pending offer, `open-agent` opens one whose device waits for approval, `state` reads it. */
export type PairOfferRequest = "open" | "open-agent" | "state";

/** What the shell's `pairOffer` answers; `unavailable` says why this app cannot ask its host at all. */
export type DesktopPairAnswer =
  | { readonly state: "pending"; readonly offer: DesktopPairOffer }
  | { readonly state: "paired"; readonly device: DesktopPairedDevice | null }
  /** An agent redeemed an agent offer and waits for an owner's approval (#2939); no device is stored yet. */
  | { readonly state: "approval" }
  | { readonly state: "expired" }
  | { readonly state: "none" }
  | { readonly state: "unavailable"; readonly reason: string };

const text = (value: unknown, key: string): string | undefined => {
  const field: unknown = typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  return typeof field === "string" ? field : undefined;
};

function offerOf(value: unknown): DesktopPairOffer | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const code = text(value, "code");
  const link = text(value, "link");
  const opens: unknown = Reflect.get(value, "opens");
  const phoneLink: unknown = Reflect.get(value, "phoneLink");
  const hostId = text(value, "hostId");
  const fingerprint = text(value, "fingerprint");
  const expiresAt: unknown = Reflect.get(value, "expiresAt");
  const slot: unknown = Reflect.get(value, "slot");
  const codeUsable: unknown = Reflect.get(value, "codeUsable");
  if (code === undefined || link === undefined || hostId === undefined || fingerprint === undefined) return undefined;
  if (typeof expiresAt !== "number" || typeof codeUsable !== "boolean") return undefined;
  if (opens !== "web" && opens !== "desktop") return undefined;
  if (slot !== "pending" && slot !== "registered" && slot !== "unavailable") return undefined;
  if (phoneLink !== undefined && typeof phoneLink !== "string") return undefined;
  const offer: DesktopPairOffer = { code, link, opens, hostId, fingerprint, expiresAt, slot, codeUsable };
  return phoneLink === undefined ? offer : { ...offer, phoneLink };
}

function deviceOf(value: unknown): DesktopPairedDevice | null | undefined {
  if (value === null) return null;
  const name = text(value, "name");
  const id = text(value, "id");
  const pairedAt = text(value, "pairedAt");
  return name === undefined || id === undefined || pairedAt === undefined ? undefined : { name, id, pairedAt };
}

/** The answer the shell relayed, checked here because the page reads the bridge as an untrusted boundary. */
export function pairAnswer(value: unknown): DesktopPairAnswer | undefined {
  const state = text(value, "state");
  if (state === undefined || typeof value !== "object" || value === null) return undefined;
  if (state === "none" || state === "expired" || state === "approval") return { state };
  if (state === "unavailable") {
    const reason = text(value, "reason");
    return reason === undefined ? undefined : { state, reason };
  }
  if (state === "pending") {
    const offer = offerOf(Reflect.get(value, "offer"));
    return offer === undefined ? undefined : { state, offer };
  }
  if (state !== "paired") return undefined;
  const device = deviceOf(Reflect.get(value, "device"));
  return device === undefined ? undefined : { state, device };
}

/**
 * This computer's pairing offer, from the desktop shell (`open` replaces a pending one, `state` reads it), or null in a
 * browser or a build whose shell has no such call.
 */
export function desktopPairOffer(
  scope: object = globalThis,
): ((request: PairOfferRequest) => Promise<DesktopPairAnswer>) | null {
  const pair = bridgeMethod("pairOffer", scope);
  if (pair === null) return null;
  return async (request) => {
    const answer = pairAnswer(await pair(request));
    if (answer === undefined) throw new Error("the desktop app answered with no pairing offer");
    return answer;
  };
}
