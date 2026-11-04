import { ed25519 } from "@noble/curves/ed25519.js";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { hostIdOf } from "./fragment.ts";
import { lookupCode } from "./lookup.ts";

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

/** The contract v1.8 statement, built from the contract's words: prefix, slot, Noise key, expiresAt as u64 BE. */
function statement(slot: string, noiseStaticPub: Uint8Array, expiresAt: number): Uint8Array {
  const prefix = new TextEncoder().encode(`doriface-pair-slot-v1${slot}`);
  const out = new Uint8Array(prefix.byteLength + 32 + 8);
  out.set(prefix, 0);
  out.set(noiseStaticPub, prefix.byteLength);
  new DataView(out.buffer).setBigUint64(prefix.byteLength + 32, BigInt(expiresAt));
  return out;
}

function honestAnswerOnSlotK7Q(): { readonly body: Record<string, unknown>; readonly noisePub: Uint8Array } {
  const { secretKey, publicKey } = ed25519.keygen();
  const noisePub = crypto.getRandomValues(new Uint8Array(32));
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const body = {
    hostId: hostIdOf(publicKey),
    noiseStaticPub: b64url(noisePub),
    signPub: b64url(publicKey),
    expiresAt,
    slotSig: b64url(ed25519.sign(statement("K7Q", noisePub, expiresAt), secretKey)),
  };
  return { body, noisePub };
}

const relayAnswers = (body: unknown) => spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));

const attackerKey = (): string => b64url(crypto.getRandomValues(new Uint8Array(32)));

afterEach(() => mock.restore());

describe("lookupCode", () => {
  test("a signed answer for the typed code's slot becomes an offer with the host's fingerprint", async () => {
    const { body, noisePub } = honestAnswerOnSlotK7Q();
    relayAnswers(body);
    const parsed = await lookupCode("K7QM4XPD", "wss://relay.example");
    expect(parsed.ok && parsed.offer.noiseStaticPub).toEqual(noisePub);
  });

  test("the host's real hostId and signPub with an attacker's Noise key and no signature are refused (#22)", async () => {
    const { body } = honestAnswerOnSlotK7Q();
    const { expiresAt: _expiresAt, slotSig: _slotSig, ...unsigned } = body;
    relayAnswers({ ...unsigned, noiseStaticPub: attackerKey() });
    expect((await lookupCode("K7QM4XPD", "wss://relay.example")).ok).toBe(false);
  });

  test("an attacker's Noise key next to the host's signature over its real key is refused (#22)", async () => {
    const { body } = honestAnswerOnSlotK7Q();
    relayAnswers({ ...body, noiseStaticPub: attackerKey() });
    expect((await lookupCode("K7QM4XPD", "wss://relay.example")).ok).toBe(false);
  });
});
