import { describe, expect, test } from "bun:test";
import {
  generateHostIdentity,
  parsePairingLink,
  parsePairingUrl,
  PAIRING_CODE_ATTEMPTS,
  PAIRING_TTL_MS,
} from "@doriface/crypto";
import { pairingOfferView } from "./pair-offer.ts";
import type { PendingPairing } from "./state/pairing.ts";

const identity = generateHostIdentity();
const now = 1_800_000_000_000;

function offer(over: Partial<PendingPairing> = {}): PendingPairing {
  return {
    code: "AB3K9XQZ",
    linkSecret: crypto.getRandomValues(new Uint8Array(32)),
    expiresAt: now + PAIRING_TTL_MS,
    slot: "registered",
    codeAttempts: 0,
    mesh: false,
    ...over,
  };
}

describe("the offer a surface shows for this computer", () => {
  test("carries what doriface-host pair prints: code, link, fingerprint, host and expiry", () => {
    const pending = offer();
    const view = pairingOfferView({
      identity,
      offer: pending,
      relayUrl: "wss://relay.example",
      webOrigin: "https://doriface.example",
    });
    expect(view.code).toBe("AB3K9XQZ");
    expect(view.expiresAt).toBe(pending.expiresAt);
    expect(view.hostId).toBe(identity.hostId);
    expect(view.fingerprint).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){9}$/);
    const parsed = parsePairingUrl(view.link);
    expect(parsed.hostId).toBe(identity.hostId);
    expect(parsed.linkSecret).toEqual(pending.linkSecret);
    expect(parsed.relayUrl).toBe("wss://relay.example");
  });

  test("without a hosted web app the link opens the desktop app, as the CLI now defaults (#594)", () => {
    const view = pairingOfferView({ identity, offer: offer() });
    expect(view.opens).toBe("desktop");
    expect(view.link.startsWith("doriface://pair#")).toBe(true);
  });

  test("an operator who names a web origin gets that page's link instead", () => {
    const view = pairingOfferView({ identity, offer: offer(), webOrigin: "https://doriface.example" });
    expect(view.opens).toBe("web");
    expect(view.link.startsWith("https://doriface.example/pair#")).toBe(true);
  });

  test("a phone's QR link is the app host's /pair page with the desktop link's fragment (#700, #747)", () => {
    const view = pairingOfferView({ identity, offer: offer() });
    expect(view.link.startsWith("doriface://pair#")).toBe(true);
    const phone = new URL(view.phoneLink);
    expect(`${phone.origin}${phone.pathname}`).toBe("https://app.doriterm.com/pair");
    expect(phone.search).toBe("");
    expect(phone.hash).toBe(new URL(view.link).hash);
    expect(parsePairingUrl(view.phoneLink)).toEqual({ ...parsePairingLink(view.link), webOrigin: phone.origin });
  });

  test("an operator's web origin is the phone's page too", () => {
    const view = pairingOfferView({ identity, offer: offer(), webOrigin: "https://doriface.example" });
    expect(view.phoneLink).toBe(view.link);
  });

  test("a code is usable only once the relay holds its slot and it is not retired", () => {
    expect(pairingOfferView({ identity, offer: offer() }).codeUsable).toBe(true);
    expect(pairingOfferView({ identity, offer: offer({ slot: "pending" }) }).codeUsable).toBe(false);
    expect(pairingOfferView({ identity, offer: offer({ slot: "unavailable" }) }).codeUsable).toBe(false);
    expect(pairingOfferView({ identity, offer: offer({ codeAttempts: PAIRING_CODE_ATTEMPTS }) }).codeUsable).toBe(
      false,
    );
  });
});
