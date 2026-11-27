import { DEFAULT_RELAY_URL, fingerprintOf, type HostIdentity } from "@doriface/crypto";
import { pairingArtifact, phonePairingLink } from "./pair-link.ts";
import { codeRetired, type PendingPairing } from "./state/pairing.ts";

/**
 * One pairing offer as a surface shows it: what `doriface-host pair` prints, minus the QR drawing (the surface draws
 * its own from `link`).
 */
export interface PairingOfferView {
  /** The 8 characters, unformatted; the surface spaces them for reading. */
  readonly code: string;
  /** `<web origin>/pair#…`, or the desktop app's `doriface://pair#…` when no web origin is configured (#594). */
  readonly link: string;
  /** What opens `link`: a web page, or the doriface desktop app. */
  readonly opens: "web" | "desktop";
  /** What the QR code encodes for a phone: `<web origin>/pair#…` with `link`'s fragment, the hosted app by default. */
  readonly phoneLink: string;
  readonly hostId: string;
  /** This host's Noise key, grouped for reading aloud, as `doriface-host fingerprint` prints it. */
  readonly fingerprint: string;
  /** When the offer stops working, in ms since the epoch. */
  readonly expiresAt: number;
  /** Where the typed code's relay slot stands: a code is only usable once it is `registered`. */
  readonly slot: PendingPairing["slot"];
  /** False once the code was used up (`PAIRING_CODE_ATTEMPTS`) or the relay holds no slot for it. */
  readonly codeUsable: boolean;
}

export interface PairingOfferParts {
  readonly identity: HostIdentity;
  readonly offer: PendingPairing;
  /** The relay the device dials; the release relay when the host has no uplink, as the CLI defaults. */
  readonly relayUrl?: string | undefined;
  /** Set only by an operator who hosts the web app; without it the link opens the desktop app. */
  readonly webOrigin?: string | undefined;
}

export function pairingOfferView({
  identity,
  offer,
  relayUrl = DEFAULT_RELAY_URL,
  webOrigin,
}: PairingOfferParts): PairingOfferView {
  const target = {
    hostId: identity.hostId,
    noiseStaticPub: identity.noise.publicKey,
    signPub: identity.sign.publicKey,
    linkSecret: offer.linkSecret,
    relayUrl,
    // The client reads it to wait for the owner's approval; the host decides from the offer it stored, not the link.
    ...(offer.agent ? { agent: true } : {}),
  };
  const artifact = pairingArtifact(target, webOrigin);
  return {
    code: offer.code,
    link: artifact.url,
    opens: artifact.opens,
    phoneLink: phonePairingLink(target, webOrigin),
    hostId: identity.hostId,
    fingerprint: fingerprintOf(identity.noise.publicKey),
    expiresAt: offer.expiresAt,
    slot: offer.slot,
    codeUsable: offer.slot === "registered" && !codeRetired(offer),
  };
}
