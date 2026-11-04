import {
  checkPairSlotAnswer,
  CloseCode,
  decodePairSlotAck,
  ed25519Signer,
  generateSigningKey,
  MuxType,
  PairSlotAckStatus,
  Uplink,
  encodePairSlotRequest,
  lookupPairSlot,
  PairLookupError,
} from "@doriface/relay-client";
import { startRawHost } from "./support/raw-host.ts";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { defer, runDeferred } from "./support/cleanup.ts";
import { Probe, socketFrom, testIp } from "./support/probe.ts";
import { AsyncQueue } from "./support/queue.ts";
import { type LocalRelay, startLocalRelay } from "./support/relay-dev.ts";
import { inOrder, times } from "./support/sequential.ts";
import { offerExpiry, uniqueSlot } from "./support/slots.ts";
import { startTestHost } from "./support/test-host.ts";
import { setUpOnce } from "./support/set-up-once.ts";

let relay: LocalRelay;

setUpOnce(async () => {
  relay = await startLocalRelay();
}, 120_000);

afterAll(() => relay?.stop());

afterEach(runDeferred);

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
    expect(await host.uplink.registerPairSlot(slot, noiseStaticPub, offerExpiry())).toBe("registered");
    expect(await lookup(typed(slot))).toEqual({
      hostId: host.uplink.hostId,
      noiseStaticPub,
      signPub: host.signer.publicKey,
    });
    host.uplink.stop();
  });

  test("a signed slot is answered with the host's expiresAt and signature, bound to that slot (v1.8)", async () => {
    const host = await startTestHost(relay.url, testIp());
    const slot = uniqueSlot();
    const noiseStaticPub = crypto.getRandomValues(new Uint8Array(32));
    const expiresAt = offerExpiry();
    expect(await host.uplink.registerPairSlot(slot, noiseStaticPub, expiresAt)).toBe("registered");
    const response = await fetch(`${relay.url}/v1/pair/${slot}`, { headers: { "cf-connecting-ip": testIp() } });
    const body: unknown = await response.json();
    const verdicts = [
      await checkPairSlotAnswer(body, slot, Date.now()),
      await checkPairSlotAnswer(body, uniqueSlot(), Date.now()),
    ];
    const record = { hostId: host.uplink.hostId, noiseStaticPub, signPub: host.signer.publicKey };
    expect(verdicts).toEqual([
      { ok: true, record },
      { ok: false, reason: "forged" },
    ]);
    expect(body).toMatchObject({ expiresAt });
    host.uplink.stop();
  });

  test("an unsigned PAIR_SLOT (a host older than v1.8) is still served, unsigned, and a v1.8 client refuses it", async () => {
    const host = await startRawHost(relay.url, testIp());
    const slot = uniqueSlot();
    host.probe.socket.send(encodePairSlotRequest(slot, crypto.getRandomValues(new Uint8Array(32))));
    const ack = await host.frame();
    expect(ack.type === MuxType.PairSlotAck && decodePairSlotAck(ack.payload)).toEqual({
      slot,
      status: PairSlotAckStatus.Registered,
    });
    const response = await fetch(`${relay.url}/v1/pair/${slot}`, { headers: { "cf-connecting-ip": testIp() } });
    const body: unknown = await response.json();
    const fields = typeof body === "object" && body !== null ? Object.keys(body).toSorted() : [];
    expect(fields).toEqual(["hostId", "noiseStaticPub", "signPub"]);
    await expect(lookup(typed(slot))).rejects.toMatchObject({ name: "PairLookupError", status: 502 });
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

  test("lookups over the per-IP rate are refused with 429", async () => {
    const ip = testIp();
    const results = await inOrder(times(21), () => lookup(typed(uniqueSlot()), ip).catch((error: unknown) => error));
    expect(results.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => undefined));
    const refused = results[20];
    expect(refused instanceof PairLookupError ? refused.status : refused).toBe(429);
  });
});
