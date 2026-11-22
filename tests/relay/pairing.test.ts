import {
  CloseCode,
  ed25519Signer,
  generateSigningKey,
  Uplink,
  encodePairSlotRequest,
  lookupPairSlot,
  PairLookupError,
  pairSlotVerdict,
} from "@doriface/relay-client";
import { afterEach, describe, expect, test } from "bun:test";
import { defer, runDeferred } from "./support/cleanup.ts";
import { Probe, socketFrom, testIp } from "./support/probe.ts";
import { AsyncQueue } from "./support/queue.ts";
import { useLocalRelay } from "./support/relay-fixture.ts";
import { times } from "./support/sequential.ts";
import { uniqueSlot } from "./support/slots.ts";
import { startTestHost } from "./support/test-host.ts";

/** The expiry a host signs with its slot: one offer TTL from now (#22). */
const offerExpiry = (): number => Date.now() + 10 * 60 * 1000;

const relay = useLocalRelay();

afterEach(runDeferred);

/** PAIR_LIMIT's period in the relay's wrangler config: 20 lookups per IP per 60 s. */
const RATE_WINDOW_MS = 60_000;
/** The room a window must have left for the rate case to start in it, else it waits for the next one. */
const RATE_ROOM_MS = 20_000;
/**
 * The rate case's own budget beside that wait: its 21 lookups, measured at most 18.4 s on a 40-core host driven to load
 * ~160 (p50 under 7 s), and about 1 s at rest.
 */
const RATE_RUN_MS = 30_000;

/** A typed code for `slot` as a person might enter it: lower case, with the display space. */
const typed = (slot: string): string => `${slot}0 abcd`.toLowerCase();

const lookup = (code: string, ip = testIp()) =>
  lookupPairSlot({
    relayUrl: relay.url,
    code,
    fetch: (url) => fetch(url, { headers: { "cf-connecting-ip": ip } }),
  });

describe("pairing slots", () => {
  test("a registered slot answers with the host's id and keys", async () => {
    const ip = testIp();
    const host = await startTestHost(relay.url, ip);
    const slot = uniqueSlot();
    const noiseStaticPub = crypto.getRandomValues(new Uint8Array(32));
    const expiresAt = offerExpiry();
    expect(await host.uplink.registerPairSlot(slot, noiseStaticPub, expiresAt)).toBe("registered");
    const record = await lookup(typed(slot));
    expect(record).toEqual({
      hostId: host.uplink.hostId,
      noiseStaticPub,
      signPub: host.signer.publicKey,
      expiresAt,
      slotSig: expect.any(Uint8Array),
    });
    // The relay returned the host's own signature over this slot, Noise key and expiry (contract v1.9, #22).
    expect(record === undefined ? undefined : pairSlotVerdict(record, slot, Date.now())).toBe("signed");
    host.uplink.stop();
  });

  test("a slot another host holds is taken; the holder may refresh it", async () => {
    const ip = testIp();
    const holder = await startTestHost(relay.url, ip);
    const other = await startTestHost(relay.url, ip);
    const slot = uniqueSlot();
    const key = crypto.getRandomValues(new Uint8Array(32));
    expect(await holder.uplink.registerPairSlot(slot, key, offerExpiry())).toBe("registered");
    expect(await other.uplink.registerPairSlot(slot, crypto.getRandomValues(new Uint8Array(32)), offerExpiry())).toBe(
      "taken",
    );
    const refreshed = crypto.getRandomValues(new Uint8Array(32));
    expect(await holder.uplink.registerPairSlot(slot, refreshed, offerExpiry())).toBe("registered");
    expect((await lookup(typed(slot)))?.noiseStaticPub).toEqual(refreshed);
    holder.uplink.stop();
    other.uplink.stop();
  });

  test("slot lookups are readable from a web origin, found or not", async () => {
    const host = await startTestHost(relay.url, testIp());
    const slot = uniqueSlot();
    await host.uplink.registerPairSlot(slot, crypto.getRandomValues(new Uint8Array(32)), offerExpiry());
    const get = (target: string) =>
      fetch(`${relay.url}/v1/pair/${target}`, {
        headers: { origin: "https://app.example", "cf-connecting-ip": testIp() },
      });
    const [found, missing] = await Promise.all([get(slot), get(uniqueSlot())]);
    expect([found.status, found.headers.get("access-control-allow-origin")]).toEqual([200, "*"]);
    expect([missing.status, missing.headers.get("access-control-allow-origin")]).toEqual([404, "*"]);
  });

  test("an unknown slot is not found", async () => {
    expect(await lookup(typed(uniqueSlot()))).toBeUndefined();
  });

  test("an unauthenticated uplink cannot register a slot", async () => {
    const slot = uniqueSlot();
    const probe = new Probe(`${relay.url.replace("http", "ws")}/v1/host/${"c".repeat(25)}a`, testIp());
    await probe.next();
    probe.socket.send(encodePairSlotRequest(slot, crypto.getRandomValues(new Uint8Array(32))));
    expect((await probe.closed).code).toBe(CloseCode.RelayAuthFailed);
    expect(await lookup(typed(slot))).toBeUndefined();
  });

  test("registering a new slot releases the host's previous one", async () => {
    const host = await startTestHost(relay.url, testIp());
    const [first, second] = [uniqueSlot(), uniqueSlot()];
    await host.uplink.registerPairSlot(first, crypto.getRandomValues(new Uint8Array(32)), offerExpiry());
    await host.uplink.registerPairSlot(second, crypto.getRandomValues(new Uint8Array(32)), offerExpiry());
    expect(await lookup(typed(first))).toBeUndefined();
    expect((await lookup(typed(second)))?.hostId).toBe(host.uplink.hostId);
    host.uplink.stop();
  });

  test("after the uplink reconnects, the host can still clear its slot and moving it releases the old one", async () => {
    const ip = testIp();
    const sockets: WebSocket[] = [];
    const answered = new AsyncQueue<void>();
    const uplink = await Uplink.start({
      relayUrl: relay.url,
      signer: ed25519Signer(generateSigningKey()),
      onSession: () => {},
      onState: (state) => {
        if (state.state === "answered") answered.push();
      },
      createSocket: (url) => {
        const ws = socketFrom(ip)(url);
        sockets.push(ws);
        return ws;
      },
    });
    defer(() => uplink.stop());
    await answered.take();
    const [moved, kept] = [uniqueSlot(), uniqueSlot()];
    await uplink.registerPairSlot(moved, crypto.getRandomValues(new Uint8Array(32)), offerExpiry());
    sockets.at(-1)?.close();
    await answered.take();
    await uplink.registerPairSlot(kept, crypto.getRandomValues(new Uint8Array(32)), offerExpiry());
    expect(await lookup(typed(moved))).toBeUndefined();
    sockets.at(-1)?.close();
    await answered.take();
    await uplink.clearPairSlot();
    expect(await lookup(typed(kept))).toBeUndefined();
  });

  test("a host whose uplink was replaced can clear the slot the old uplink registered", async () => {
    const ip = testIp();
    const first = await startTestHost(relay.url, ip);
    const slot = uniqueSlot();
    await first.uplink.registerPairSlot(slot, crypto.getRandomValues(new Uint8Array(32)), offerExpiry());
    const second = await startTestHost(relay.url, ip, { secretKey: first.secretKey });
    expect(await first.uplink.stopped).toBe(CloseCode.UplinkReplaced);
    await second.uplink.clearPairSlot(slot);
    expect(await lookup(typed(slot))).toBeUndefined();
  });

  test("a cleared slot is not found any more", async () => {
    const host = await startTestHost(relay.url, testIp());
    const slot = uniqueSlot();
    expect(await host.uplink.registerPairSlot(slot, crypto.getRandomValues(new Uint8Array(32)), offerExpiry())).toBe(
      "registered",
    );
    await host.uplink.clearPairSlot();
    expect(await lookup(typed(slot))).toBeUndefined();
    host.uplink.stop();
  });

  test(
    "lookups over the per-IP rate are refused with 429",
    async () => {
      // The local relay's rate limiter (miniflare) counts in windows aligned to the wall clock, so a run that crosses a
      // boundary starts a fresh count and its 21st lookup is allowed. Start in a window with room for the whole run.
      const left = RATE_WINDOW_MS - (Date.now() % RATE_WINDOW_MS);
      if (left < RATE_ROOM_MS) await Bun.sleep(left + 50);
      const window = Math.floor(Date.now() / RATE_WINDOW_MS);
      const ip = testIp();
      // The limit counts requests, not their order: the 20 it allows go together, and the 21st once they are counted.
      const allowed = await Promise.all(
        times(20).map(() => lookup(typed(uniqueSlot()), ip).catch((error: unknown) => error)),
      );
      const refused = await lookup(typed(uniqueSlot()), ip).catch((error: unknown) => error);
      expect(Math.floor(Date.now() / RATE_WINDOW_MS), "the run stayed in one rate window").toBe(window);
      expect(allowed).toEqual(Array.from({ length: 20 }, () => undefined));
      expect(refused instanceof PairLookupError ? refused.status : refused).toBe(429);
    },
    RATE_ROOM_MS + RATE_RUN_MS,
  );
});
