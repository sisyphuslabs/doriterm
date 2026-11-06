import type { DesktopPairAnswer, DesktopPairOffer, DesktopPairedDevice } from "../desktop/pair-bridge.ts";
import { formatCode } from "../pair/code.ts";

/** What the dialog shows: the last answer the shell relayed, read against the clock. */
export type PairDeviceView =
  | { readonly kind: "asking" }
  | { readonly kind: "offer"; readonly offer: DesktopPairOffer; readonly expired: boolean }
  | { readonly kind: "paired"; readonly device: DesktopPairedDevice | null }
  | { readonly kind: "expired" }
  | { readonly kind: "unavailable"; readonly reason: string };

export function pairDeviceView(answer: DesktopPairAnswer | null, now: number): PairDeviceView {
  if (answer === null) return { kind: "asking" };
  switch (answer.state) {
    case "pending":
      return { kind: "offer", offer: answer.offer, expired: now >= answer.offer.expiresAt };
    case "paired":
      return { kind: "paired", device: answer.device };
    case "expired":
      return { kind: "expired" };
    case "unavailable":
      return { kind: "unavailable", reason: answer.reason };
    case "none":
      return { kind: "expired" };
  }
}

/** The code as people read it aloud and type it: two groups of four. */
export function offerCode(offer: DesktopPairOffer): string {
  return formatCode(offer.code);
}

/** Milliseconds left on an offer; 0 once it is spent. */
export function remainingMs(offer: DesktopPairOffer, now: number): number {
  return Math.max(0, offer.expiresAt - now);
}

/** `m:ss`, for a countdown that never shows a negative. */
export function countdown(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function expiryLine(offer: DesktopPairOffer, now: number): string {
  const left = remainingMs(offer, now);
  return left === 0 ? "This offer has expired." : `Expires in ${countdown(left)}.`;
}

/** Why typing the code may not work yet, in the CLI's terms; undefined when it does. */
export function slotNote(offer: DesktopPairOffer): string | undefined {
  if (offer.codeUsable) return undefined;
  return offer.slot === "pending"
    ? "This computer's relay uplink is not up yet, so the code may not work for a moment. The link and QR code already do."
    : "Typing the code needs the relay, which has no slot for it yet. Scan the QR code or open the link instead.";
}

/** What opens the link, said plainly: the link is for another computer, the QR code for a phone. */
export function linkOpens(opens: DesktopPairOffer["opens"]): string {
  return opens === "web"
    ? "Opens the Doriterm web app on the device you pair."
    : "Opens the Doriterm desktop app on another computer. On a phone, scan the QR code or type the code above.";
}

/** What the QR code encodes: the phone's web link, or `link` from a host older than #700 that sends none. */
export function qrLink(offer: DesktopPairOffer): string {
  return offer.phoneLink ?? offer.link;
}
