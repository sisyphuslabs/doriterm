import { describe, expect, test } from "bun:test";
import { lookupPairSlot, PairLookupError } from "./pair-lookup.ts";
import { ed25519Signer, generateSigningKey } from "./signer.ts";
import { hostIdOf, toBase64Url } from "./wire/index.ts";

interface Call {
  readonly url: string;
  readonly signal: AbortSignal | undefined;
}

type Fetch = (url: string, init?: { readonly signal?: AbortSignal }) => Promise<Response>;

function recordingFetch(response: () => Response): { calls: Call[]; fetch: Fetch } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, signal: init?.signal });
      return response();
    },
  };
}

describe("lookupPairSlot", () => {
  test("a 200 whose body is not JSON is a malformed answer (502)", async () => {
    const { fetch } = recordingFetch(() => new Response("<html>", { status: 200 }));
    const lookup = lookupPairSlot({ relayUrl: "https://relay.example", code: "AB3K9XQZ", fetch });
    await expect(lookup).rejects.toMatchObject({ name: "PairLookupError", status: 502 });
    await expect(lookup).rejects.toBeInstanceOf(PairLookupError);
  });

  test("a ws(s) relay URL is looked up over http(s)", async () => {
    const { calls, fetch } = recordingFetch(() => new Response("{}", { status: 404 }));
    await lookupPairSlot({ relayUrl: "wss://relay.example", code: "AB3K9XQZ", fetch });
    await lookupPairSlot({ relayUrl: "ws://127.0.0.1:8787", code: "AB3K9XQZ", fetch });
    expect(calls.map(({ url }) => url)).toEqual([
      "https://relay.example/v1/pair/AB3",
      "http://127.0.0.1:8787/v1/pair/AB3",
    ]);
  });

  test("a signed answer for the typed code's slot is the host's record", async () => {
    const host = await signedHost();
    const record = await lookupPairSlot({
      relayUrl: "https://relay.example",
      code: "AB3K9XQZ",
      fetch: answering(host.answer),
    });
    expect(record).toEqual({ hostId: host.hostId, noiseStaticPub: host.noiseStaticPub, signPub: host.signPub });
  });

  test("the caller's abort signal reaches the request", async () => {
    const { calls, fetch } = recordingFetch(() => new Response("{}", { status: 404 }));
    const controller = new AbortController();
    await lookupPairSlot({ relayUrl: "https://relay.example", code: "AB3K9XQZ", fetch, signal: controller.signal });
    expect(calls[0]?.signal).toBe(controller.signal);
  });
});

/**
 * The statement a host signs for its slot (contract v1.8), built here from the contract's words rather than from the
 * implementation, so a codec that drifts from the contract fails these tests too.
 */
function statement(slot: string, noiseStaticPub: Uint8Array, expiresAt: number): Uint8Array {
  const prefix = new TextEncoder().encode(`doriface-pair-slot-v1${slot}`);
  const out = new Uint8Array(prefix.byteLength + 32 + 8);
  out.set(prefix, 0);
  out.set(noiseStaticPub, prefix.byteLength);
  new DataView(out.buffer).setBigUint64(prefix.byteLength + 32, BigInt(expiresAt));
  return out;
}

interface SignedHost {
  readonly hostId: string;
  readonly signPub: Uint8Array;
  readonly noiseStaticPub: Uint8Array;
  readonly expiresAt: number;
  readonly sign: (message: Uint8Array) => Uint8Array;
  /** What an honest relay answers for slot AB3. */
  readonly answer: Record<string, unknown>;
}

async function signedHost(expiresAt = Date.now() + 10 * 60 * 1000): Promise<SignedHost> {
  const signer = ed25519Signer(generateSigningKey());
  const sign = (message: Uint8Array): Uint8Array => {
    const signature = signer.sign(message);
    if (signature instanceof Promise) throw new Error("the test signer is synchronous");
    return signature;
  };
  const noiseStaticPub = crypto.getRandomValues(new Uint8Array(32));
  const hostId = await hostIdOf(signer.publicKey);
  const answer = {
    hostId,
    noiseStaticPub: toBase64Url(noiseStaticPub),
    signPub: toBase64Url(signer.publicKey),
    expiresAt,
    slotSig: toBase64Url(sign(statement("AB3", noiseStaticPub, expiresAt))),
  };
  return { hostId, signPub: signer.publicKey, noiseStaticPub, expiresAt, sign, answer };
}

const answering = (body: unknown): Fetch => recordingFetch(() => Response.json(body)).fetch;

const lookUp = (body: unknown, code = "AB3K9XQZ") =>
  lookupPairSlot({ relayUrl: "https://relay.example", code, fetch: answering(body) });

describe("a lookup answer whose Noise key the host did not sign (#22)", () => {
  test("the host's real hostId and signPub with an attacker's Noise key and no signature are refused", async () => {
    const host = await signedHost();
    const { expiresAt: _expiresAt, slotSig: _slotSig, ...unsigned } = host.answer;
    const swapped = { ...unsigned, noiseStaticPub: toBase64Url(crypto.getRandomValues(new Uint8Array(32))) };
    await expect(lookUp(swapped)).rejects.toMatchObject({ name: "PairLookupError", status: 502 });
  });

  test("an attacker's Noise key next to the host's signature over its real key is refused", async () => {
    const host = await signedHost();
    const swapped = { ...host.answer, noiseStaticPub: toBase64Url(crypto.getRandomValues(new Uint8Array(32))) };
    await expect(lookUp(swapped)).rejects.toMatchObject({ name: "PairLookupError", status: 502 });
  });
});
