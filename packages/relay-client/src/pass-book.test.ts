import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, test } from "bun:test";
import { PASS_LIMITS, PassBook, type PassStore, type StoredPass } from "./pass-book.ts";
import { generateSigningKey } from "./signer.ts";
import { fromBase64Url } from "./wire/base64url.ts";
import { PASS_BYTES, proofMessage } from "./wire/pass.ts";

const ORIGIN = "wss://relay.example";
const DAY_S = 24 * 60 * 60;

function memoryStore(initial: ReadonlyMap<string, StoredPass> = new Map()): PassStore & { saved: number } {
  let passes = initial;
  return {
    saved: 0,
    load: () => passes,
    save(next) {
      passes = new Map(next);
      this.saved += 1;
    },
  };
}

async function passFor(
  secretKey: Uint8Array,
  issuedAt: number,
  expiresAt: number,
  version = 1,
): Promise<Uint8Array<ArrayBuffer>> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ed25519.getPublicKey(secretKey)));
  const pass = new Uint8Array(PASS_BYTES);
  const view = new DataView(pass.buffer);
  view.setUint8(0, version);
  view.setUint8(1, 1);
  view.setUint32(2, issuedAt);
  view.setUint32(6, expiresAt);
  pass.set(digest.subarray(0, 16), 10);
  pass.fill(9, 26);
  return pass;
}

async function bookAt(nowMs: { value: number }, store = memoryStore()) {
  const secretKey = generateSigningKey();
  const logs: string[] = [];
  const book = await PassBook.create({ secretKey, store, now: () => nowMs.value, log: (line) => logs.push(line) });
  return { book, secretKey, store, logs };
}

describe("PassBook (contract v1.6)", () => {
  test("a valid PASS is stored with its clock offset and a proof verifies under the host key", async () => {
    const now = { value: 1_000_000 };
    const { book, secretKey, store } = await bookAt(now);
    const relayNowMs = 1_005_000;
    const pass = await passFor(secretKey, relayNowMs / 1000, relayNowMs / 1000 + 30 * DAY_S);
    book.received(ORIGIN, { relayNowMs, pass });
    expect(store.load().get(ORIGIN)).toEqual({ pass, offsetMs: 5_000, receivedAt: 1_000_000 });
    const proof = fromBase64Url(book.proof("client", "a".repeat(26), ORIGIN) ?? "");
    if (proof === undefined) throw new Error("the proof is not base64url");
    expect(proof.byteLength).toBe(179);
    const ts = Number(new DataView(proof.buffer).getBigUint64(1 + 58 + 32));
    expect(ts).toBe(1_005_000);
    const signPub = proof.slice(59, 91);
    const { message } = proofMessage({
      pass,
      signPub,
      relayOrigin: ORIGIN,
      role: "client",
      target: "a".repeat(26),
      ts,
      nonce: proof.slice(99, 115),
    });
    expect(ed25519.verify(proof.slice(115), message, ed25519.getPublicKey(secretKey))).toBe(true);
  });

  test("a PASS that is not ours, of another version, already expired, or the 8-byte form is ignored", async () => {
    const now = { value: 1_000_000 };
    const { book, secretKey, store } = await bookAt(now);
    const someoneElse = generateSigningKey();
    const issued = 1_000;
    const frames = [
      { relayNowMs: issued * 1000, pass: await passFor(someoneElse, issued, issued + DAY_S) },
      { relayNowMs: issued * 1000, pass: await passFor(secretKey, issued, issued + DAY_S, 2) },
      { relayNowMs: (issued + DAY_S) * 1000, pass: await passFor(secretKey, issued, issued + DAY_S) },
      { relayNowMs: issued * 1000 },
    ];
    for (const frame of frames) book.received(ORIGIN, frame);
    expect(store.saved).toBe(0);
    expect(book.proof("host", "a".repeat(26), ORIGIN)).toBeUndefined();
    expect(book.wantsPass(ORIGIN)).toBe(true);
  });

  test("a pass with less than the margin left is not presented", async () => {
    const now = { value: 0 };
    const { book, secretKey } = await bookAt(now);
    book.received(ORIGIN, { relayNowMs: 0, pass: await passFor(secretKey, 0, 120) });
    expect(book.proof("client", "a".repeat(26), ORIGIN)).toBeDefined();
    now.value = 120_000 - PASS_LIMITS.expiryMarginMs + 1;
    expect(book.proof("client", "a".repeat(26), ORIGIN)).toBeUndefined();
  });

  test("a refusal marks the pass unusable and asks for a new one; three in a row stop proofs for 10 minutes", async () => {
    const now = { value: 0 };
    const { book, secretKey, logs } = await bookAt(now);
    const wanted: string[] = [];
    book.onWant((origin) => wanted.push(origin));
    const fresh = async (): Promise<void> =>
      book.received(ORIGIN, {
        relayNowMs: now.value,
        pass: await passFor(secretKey, now.value / 1000, now.value / 1000 + DAY_S),
      });
    await fresh();
    book.refused(ORIGIN);
    expect(book.proof("client", "a".repeat(26), ORIGIN)).toBeUndefined();
    expect(wanted).toEqual([ORIGIN]);
    await fresh();
    book.refused(ORIGIN);
    await fresh();
    book.refused(ORIGIN);
    await fresh();
    expect(book.proof("client", "a".repeat(26), ORIGIN)).toBeUndefined();
    expect(logs).toHaveLength(1);
    now.value += PASS_LIMITS.cooldownMs + 1;
    expect(book.proof("client", "a".repeat(26), ORIGIN)).toBeDefined();
  });

  test("several refusals of the same pass count once; only a refusal of a newer pass advances the count", async () => {
    const now = { value: 0 };
    const { book, secretKey, logs } = await bookAt(now);
    const fresh = async (): Promise<void> =>
      book.received(ORIGIN, { relayNowMs: 0, pass: await passFor(secretKey, 0, DAY_S) });
    await fresh();
    book.refused(ORIGIN);
    book.refused(ORIGIN);
    book.refused(ORIGIN);
    await fresh();
    book.refused(ORIGIN);
    book.refused(ORIGIN);
    await fresh();
    expect(logs).toEqual([]);
    expect(book.proof("client", "a".repeat(26), ORIGIN)).toBeDefined();
    book.refused(ORIGIN);
    expect(logs).toHaveLength(1);
  });

  test("an accepted proof resets the refusal count", async () => {
    const now = { value: 0 };
    const { book, secretKey, logs } = await bookAt(now);
    const fresh = async (): Promise<void> =>
      book.received(ORIGIN, { relayNowMs: 0, pass: await passFor(secretKey, 0, DAY_S) });
    await fresh();
    book.refused(ORIGIN);
    await fresh();
    book.accepted(ORIGIN);
    await fresh();
    book.refused(ORIGIN);
    await fresh();
    book.refused(ORIGIN);
    await fresh();
    expect(logs).toEqual([]);
    expect(book.proof("client", "a".repeat(26), ORIGIN)).toBeDefined();
  });

  test("a stored pass survives a restart, and one older than a day is refreshed", async () => {
    const now = { value: 0 };
    const store = memoryStore();
    const first = await bookAt(now, store);
    first.book.received(ORIGIN, { relayNowMs: 7_000, pass: await passFor(first.secretKey, 0, 30 * DAY_S) });
    const restarted = await PassBook.create({ secretKey: first.secretKey, store, now: () => now.value });
    expect(restarted.wantsPass(ORIGIN)).toBe(false);
    expect(restarted.proof("host", "a".repeat(26), ORIGIN)).toBeDefined();
    now.value = PASS_LIMITS.refreshAgeMs + 1;
    expect(restarted.wantsPass(ORIGIN)).toBe(true);
  });
});
