// A stand-in relay for pairing captures: it never leaves the browser, so no capture touches a real relay.
import { pairSlotStatement } from "@doriface/relay-client";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { Page } from "@playwright/test";
import { hostIdOf } from "../src/pair/fragment.ts";

export const FAKE_RELAY = "wss://relay.invalid";
const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const signSecret = new Uint8Array(32).map((_, index) => (index * 37 + 11) % 256);
const signPub = ed25519.getPublicKey(signSecret);
const noisePub = new Uint8Array(32).map((_, index) => (index * 53 + 7) % 256);
const hostId = hostIdOf(signPub);

export const PAIR_CODE = "K7QM 4XPD";
export const PAIR_LINK = `/pair#h=${hostId}&k=${b64url(noisePub)}&s=${b64url(signPub)}&p=${b64url(new Uint8Array(32).fill(3))}&r=${FAKE_RELAY}`;
/** A link whose host ID does not belong to its signing key. */
export const BAD_LINK = PAIR_LINK.replace(`h=${hostId}`, `h=${"a".repeat(26)}`);

/** Relay settings that point pairing at the fake relay; the workspace stays on first run. */
export const PAIRING_SETTINGS = {
  mode: "relay",
  relayUrl: FAKE_RELAY,
  directUrl: "",
  hostId: "",
  hostKey: "",
  loopbackUrl: "",
  token: "",
};

/** The fake host's lookup answer for PAIR_CODE's slot, signed by its key as a contract v1.8 host signs it. */
function signedAnswer(): Record<string, unknown> {
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const statement = pairSlotStatement(PAIR_CODE.slice(0, 3), noisePub, expiresAt);
  const slotSig = b64url(ed25519.sign(statement, signSecret));
  return { hostId, noiseStaticPub: b64url(noisePub), signPub: b64url(signPub), expiresAt, slotSig };
}

/** Answers the code lookup with the fake host, and closes the pairing session with `closeCode` once it speaks. */
export async function fakeRelay(page: Page, closeCode: number): Promise<void> {
  await page.route("https://relay.invalid/v1/pair/*", (route) => route.fulfill({ json: signedAnswer() }));
  await page.routeWebSocket(/^wss:\/\/relay\.invalid\//, (ws) => {
    ws.onMessage(() => ws.close({ code: closeCode, reason: "refused" }));
  });
}
