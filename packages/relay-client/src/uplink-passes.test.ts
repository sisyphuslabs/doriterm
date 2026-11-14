import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { PassBook, type PassStore, type StoredPass } from "./pass-book.ts";
import { ed25519Signer, generateSigningKey } from "./signer.ts";
import { Uplink, type UplinkState } from "./uplink.ts";
import { MuxType, PASS_BYTES } from "./wire/index.ts";

/** One scripted reaction per uplink attempt, in order: what the fake relay does after the host answers. */
type Script = "serve-pass" | "no-pass" | "refuse-4412" | "limit-4429";

interface Attempt {
  readonly url: URL;
}

const attempts: Attempt[] = [];
let script: Script[] = [];
let issuedPass: Uint8Array<ArrayBuffer> = new Uint8Array(PASS_BYTES);

const relay = Bun.serve<{ readonly attempt: Attempt; readonly step: Script }>({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request, server) => {
    const attempt = { url: new URL(request.url) };
    attempts.push(attempt);
    const step = script.shift() ?? "no-pass";
    return server.upgrade(request, { data: { attempt, step } }) ? undefined : new Response("upgrade", { status: 426 });
  },
  websocket: {
    open: (ws) => {
      if (ws.data.step === "refuse-4412") return ws.close(4412, "relay pass refused");
      if (ws.data.step === "limit-4429") return ws.close(4429, "rate limited");
      ws.send(new Uint8Array(32));
    },
    message: (ws: ServerWebSocket<{ readonly attempt: Attempt; readonly step: Script }>, message) => {
      if (typeof message !== "string" && message.byteLength === 96 && ws.data.step === "serve-pass")
        ws.send(passFrame());
    },
  },
});
afterAll(() => relay.stop(true));

function passFrame(): Uint8Array {
  const frame = new Uint8Array(5 + 8 + PASS_BYTES);
  frame[0] = MuxType.Pass;
  new DataView(frame.buffer).setBigUint64(5, BigInt(Date.now()));
  frame.set(issuedPass, 13);
  return frame;
}

function memoryStore(): PassStore {
  let passes: ReadonlyMap<string, StoredPass> = new Map();
  return { load: () => passes, save: (next) => (passes = new Map(next)) };
}

async function hostWithBook(): Promise<{ readonly book: PassBook; readonly secretKey: Uint8Array }> {
  const secretKey = generateSigningKey();
  const book = await PassBook.create({ secretKey, store: memoryStore() });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ed25519Signer(secretKey).publicKey));
  issuedPass = new Uint8Array(PASS_BYTES);
  const view = new DataView(issuedPass.buffer);
  view.setUint8(0, 1);
  view.setUint8(1, 1);
  const nowS = Math.floor(Date.now() / 1000);
  view.setUint32(2, nowS);
  view.setUint32(6, nowS + 30 * 24 * 60 * 60);
  issuedPass.set(digest.subarray(0, 16), 10);
  return { book, secretKey };
}

let uplink: Uplink | undefined;
afterEach(() => {
  uplink?.stop();
  attempts.length = 0;
  script = [];
});

/** Starts an uplink and resolves on the first `count` states, so a test waits on exactly the transitions it needs. */
async function start(secretKey: Uint8Array, book: PassBook, count: number): Promise<UplinkState[]> {
  const states: UplinkState[] = [];
  const reached = Promise.withResolvers<UplinkState[]>();
  uplink = await Uplink.start({
    relayUrl: `http://127.0.0.1:${relay.port}`,
    signer: ed25519Signer(secretKey),
    proofs: book,
    random: () => 0,
    onSession: () => undefined,
    onState: (state) => {
      states.push(state);
      if (states.length === count) reached.resolve(states);
    },
  });
  return reached.promise;
}

describe("the uplink and relay passes (contract v1.6)", () => {
  test("it dials ?pass=1, keeps the PASS it is sent, and presents a proof on the next attempt", async () => {
    const { book, secretKey } = await hostWithBook();
    script = ["serve-pass", "refuse-4412"];
    const passed = new Promise<void>((resolve) => book.onPass(() => resolve()));
    await start(secretKey, book, 1);
    await passed;
    expect(attempts[0]?.url.searchParams.get("pass")).toBe("1");
    expect(attempts[0]?.url.searchParams.has("proof")).toBe(false);
    expect(book.proof("host", uplink?.hostId ?? "", `ws://127.0.0.1:${relay.port}`)).toBeDefined();
  });

  test("a 4412 makes the next attempt go at once and without a proof", async () => {
    const { book, secretKey } = await hostWithBook();
    script = ["serve-pass", "refuse-4412", "no-pass"];
    const passed = new Promise<void>((resolve) => book.onPass(() => resolve()));
    const firstState = start(secretKey, book, 1);
    await passed;
    await firstState;
    uplink?.stop();
    script = ["refuse-4412", "no-pass"];
    attempts.length = 0;
    const waiting = await (async () => {
      const seen: UplinkState[] = [];
      const done = Promise.withResolvers<UplinkState[]>();
      uplink = await Uplink.start({
        relayUrl: `http://127.0.0.1:${relay.port}`,
        signer: ed25519Signer(secretKey),
        proofs: book,
        onSession: () => undefined,
        onState: (state) => {
          seen.push(state);
          if (state.state === "answered") done.resolve(seen);
        },
      });
      return done.promise;
    })();
    expect(attempts[0]?.url.searchParams.has("proof")).toBe(true);
    expect(attempts[1]?.url.searchParams.has("proof")).toBe(false);
    expect(waiting.find((state) => state.state === "waiting")).toEqual({
      state: "waiting",
      code: 4412,
      reason: "relay pass refused",
      retryInMs: 0,
    });
  });

  test("a 4429 on an attempt without a proof waits the 30-60 s registration backoff", async () => {
    const { book, secretKey } = await hostWithBook();
    script = ["limit-4429"];
    const states = await start(secretKey, book, 2);
    expect(states[1]).toEqual({ state: "waiting", code: 4429, reason: "rate limited", retryInMs: 30_000 });
  });

  test("a 4412 on an attempt without a proof is an ordinary failure: the usual backoff, nothing marked", async () => {
    const { book, secretKey } = await hostWithBook();
    script = ["refuse-4412"];
    const wanted: string[] = [];
    book.onWant((origin) => wanted.push(origin));
    const states = await start(secretKey, book, 2);
    expect(states[1]).toEqual({ state: "waiting", code: 4412, reason: "relay pass refused", retryInMs: 250 });
    expect(wanted).toEqual([]);
  });
});
