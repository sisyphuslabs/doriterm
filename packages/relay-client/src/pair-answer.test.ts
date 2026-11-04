import { describe, expect, test } from "bun:test";
import { checkPairSlotAnswer, PAIR_SLOT_CLOCK_ALLOWANCE_MS } from "./pair-answer.ts";
import { ed25519Signer, generateSigningKey } from "./signer.ts";
import { hostIdOf, pairSlotStatement, toBase64Url } from "./wire/index.ts";

const NOW = 1_800_000_000_000;
const EXPIRES_AT = NOW + 5 * 60 * 1000;

async function sign(secretKey: Uint8Array, slot: string, noise: Uint8Array, expiresAt: number): Promise<string> {
  return toBase64Url(await ed25519Signer(secretKey).sign(pairSlotStatement(slot, noise, expiresAt)));
}

async function answerFor(overrides: Readonly<Record<string, unknown>> = {}) {
  const secretKey = generateSigningKey();
  const signPub = ed25519Signer(secretKey).publicKey;
  const noise = crypto.getRandomValues(new Uint8Array(32));
  const body = {
    hostId: await hostIdOf(signPub),
    noiseStaticPub: toBase64Url(noise),
    signPub: toBase64Url(signPub),
    expiresAt: EXPIRES_AT,
    slotSig: await sign(secretKey, "AB3", noise, EXPIRES_AT),
    ...overrides,
  };
  return { body, secretKey, noise, signPub };
}

const reasonOf = async (body: unknown, slot = "AB3", now = NOW) => {
  const answer = await checkPairSlotAnswer(body, slot, now);
  return answer.ok ? "ok" : answer.reason;
};

describe("checkPairSlotAnswer (contract v1.8)", () => {
  test("a host-signed answer for this slot is the host's record, keys as sent", async () => {
    const { body, noise, signPub } = await answerFor();
    const answer = await checkPairSlotAnswer(body, "AB3", NOW);
    expect(answer).toEqual({ ok: true, record: { hostId: body.hostId, noiseStaticPub: noise, signPub } });
  });

  test("the signature binds the slot: an answer signed for another slot is forged", async () => {
    expect(await reasonOf((await answerFor()).body, "AB4")).toBe("forged");
  });

  test("the signature binds the expiry: a changed expiresAt is forged", async () => {
    expect(await reasonOf({ ...(await answerFor()).body, expiresAt: EXPIRES_AT + 1 })).toBe("forged");
  });

  test("a signature by another key over the same statement is forged", async () => {
    const { body, noise } = await answerFor();
    const slotSig = await sign(generateSigningKey(), "AB3", noise, EXPIRES_AT);
    expect(await reasonOf({ ...body, slotSig })).toBe("forged");
  });

  test("a signPub swapped for the signer of the forged statement no longer hashes to hostId", async () => {
    const { body, noise } = await answerFor();
    const attacker = generateSigningKey();
    const slotSig = await sign(attacker, "AB3", noise, EXPIRES_AT);
    expect(await reasonOf({ ...body, signPub: toBase64Url(ed25519Signer(attacker).publicKey), slotSig })).toBe(
      "malformed",
    );
  });

  test("an answer with neither field is unsigned; with one of them, or a bad value, it is malformed", async () => {
    const { body } = await answerFor();
    const { expiresAt: _expiresAt, slotSig: _slotSig, ...bare } = body;
    expect(await reasonOf(bare)).toBe("unsigned");
    const malformed = [
      { ...bare, expiresAt: EXPIRES_AT },
      { ...bare, slotSig: body.slotSig },
      { ...body, expiresAt: "1800000300000" },
      { ...body, expiresAt: 1.5 },
      { ...body, expiresAt: -1 },
      { ...body, slotSig: body.slotSig.slice(0, 80) },
      { ...body, slotSig: "!" },
    ];
    expect(await Promise.all(malformed.map((answer) => reasonOf(answer)))).toEqual(malformed.map(() => "malformed"));
  });

  test("an offer that ended more than the clock allowance ago is expired, one that ended at it is not", async () => {
    const { body } = await answerFor();
    expect(await reasonOf(body, "AB3", EXPIRES_AT + PAIR_SLOT_CLOCK_ALLOWANCE_MS)).toBe("ok");
    expect(await reasonOf(body, "AB3", EXPIRES_AT + PAIR_SLOT_CLOCK_ALLOWANCE_MS + 1)).toBe("expired");
  });
});
