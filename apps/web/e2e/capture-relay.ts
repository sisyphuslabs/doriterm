// A stand-in relay for pairing captures: it never leaves the browser, so no capture touches a real relay. It answers at
// the production relay's address because a release build dials no other relay (#389).
import { pairSlotStatement } from "@doriface/relay-client/wire";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { Page } from "@playwright/test";
import { hostIdOf } from "../src/pair/fragment.ts";

export const FAKE_RELAY = "wss://relay-doriface.omo.dev";
const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const signSecret = new Uint8Array(32).map((_, index) => (index * 37 + 11) % 256);
const signPub = ed25519.getPublicKey(signSecret);
const noisePub = new Uint8Array(32).map((_, index) => (index * 53 + 7) % 256);
const hostId = hostIdOf(signPub);

export const PAIR_CODE = "K7QM 4XPD";
export const PAIR_LINK = `/pair#h=${hostId}&k=${b64url(noisePub)}&s=${b64url(signPub)}&p=${b64url(new Uint8Array(32).fill(3))}&r=${FAKE_RELAY}`;
/** The same offer as a mesh invite (`&m=1`), which admits a machine instead of a device. */
export const MESH_LINK = `${PAIR_LINK}&m=1`;
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

/** What a v1.9 relay answers for the fake host's slot: the host's own signature over its slot and Noise key (#22). */
function signedAnswer(url: string): Record<string, unknown> {
  const slot = url.slice(url.lastIndexOf("/") + 1);
  const expiresAt = Date.now() + 5 * 60 * 1000;
  const slotSig = ed25519.sign(pairSlotStatement(slot, noisePub, expiresAt), signSecret);
  return { hostId, noiseStaticPub: b64url(noisePub), signPub: b64url(signPub), expiresAt, slotSig: b64url(slotSig) };
}

/** Answers the code lookup with the fake host, and closes the pairing session with `closeCode` once it speaks. */
export async function fakeRelay(page: Page, closeCode: number): Promise<void> {
  await page.route("https://relay-doriface.omo.dev/v1/pair/*", (route) =>
    route.fulfill({ json: signedAnswer(route.request().url()) }),
  );
  await page.routeWebSocket(/^wss:\/\/relay-doriface\.omo\.dev(:\d+)?\//, (ws) => {
    ws.onMessage(() => ws.close({ code: closeCode, reason: "refused" }));
  });
}
