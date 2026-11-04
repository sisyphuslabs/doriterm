import {
  CloseCode,
  connectRelayClient,
  decodePairSlotAck,
  lookupPairSlot,
  MuxType,
  PairLookupError,
  PairSlotAckStatus,
  type SessionLink,
  type WebSocketLink,
} from "@doriface/relay-client";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { defer, runDeferred } from "./support/cleanup.ts";
import { closedWith, received } from "./support/links.ts";
import { socketFrom, testIp } from "./support/probe.ts";
import { startRawHost } from "./support/raw-host.ts";
import { type LocalRelay, startLocalRelay } from "./support/relay-dev.ts";
import { inOrder, times } from "./support/sequential.ts";
import { offerExpiry, uniqueSlot } from "./support/slots.ts";
import { startTestHost, type TestHost } from "./support/test-host.ts";
import { setUpOnce } from "./support/set-up-once.ts";

let relay: LocalRelay;

setUpOnce(async () => {
  relay = await startLocalRelay();
}, 120_000);

afterAll(() => relay?.stop());

afterEach(runDeferred);

async function pairingHost(): Promise<{ readonly host: TestHost; readonly slot: string }> {
  const host = await startTestHost(relay.url, testIp());
  const slot = uniqueSlot();
  expect(await host.uplink.registerPairSlot(slot, crypto.getRandomValues(new Uint8Array(32)), offerExpiry())).toBe(
    "registered",
  );
  return { host, slot };
}

const lookupFrom = (slot: string, ip: string): Promise<string | number | undefined> =>
  lookupPairSlot({
    relayUrl: relay.url,
    code: `${slot}00000`,
    fetch: (url) => fetch(url, { headers: { "cf-connecting-ip": ip } }),
  }).then(
    (record) => record?.hostId,
    (error: unknown) => (error instanceof PairLookupError ? error.status : undefined),
  );

const dialPairing = (host: TestHost, slot: string, ip: string): Promise<WebSocketLink> =>
  connectRelayClient({ relayUrl: relay.url, hostId: host.uplink.hostId, pairSlot: slot, createSocket: socketFrom(ip) });

/** A pairing session the client opened with msg1; `answer` has the host reply, which charges the slot. */
async function pairingSession(host: TestHost, slot: string, ip: string, answer: boolean): Promise<SessionLink> {
  const client = await dialPairing(host, slot, ip);
  defer(() => client.close());
  const session = await host.sessions.take();
  const atHost = received(session);
  client.send(new Uint8Array([1]));
  await atHost.take();
  if (answer) {
    const atClient = received(client);
    await session.send(new Uint8Array([2]));
    await atClient.take();
  }
  const ended = closedWith(session);
  client.close();
  await ended;
  return session;
}

/** Four sources spending 3, 3, 3 and 1: ten attempts with no source over its quota. */
const tenFromFourSources = (): string[] => {
  const [a, b, c, d] = [testIp(), testIp(), testIp(), testIp()];
  return [a, a, a, b, b, b, c, c, c, d];
};

describe("pairing budget and quotas", () => {
  test("a pairing session's OPEN names its slot; an ordinary session's does not", async () => {
    const { host, slot } = await pairingHost();
    expect((await pairingSession(host, slot, testIp(), false)).pairSlot).toBe(slot);
    const ordinary = await connectRelayClient({
      relayUrl: relay.url,
      hostId: host.uplink.hostId,
      createSocket: socketFrom(testIp()),
    });
    defer(() => ordinary.close());
    expect((await host.sessions.take()).pairSlot).toBeUndefined();
  });

  test("a slot answers 10 lookups per 10 minutes across sources, then 429", async () => {
    const { host, slot } = await pairingHost();
    const answers = await inOrder(tenFromFourSources(), (ip) => lookupFrom(slot, ip));
    expect(answers).toEqual(times(10).map(() => host.uplink.hostId));
    expect(await lookupFrom(slot, testIp())).toBe(429);
  });

  test("one source gets 3 lookups per slot per 10 minutes; another source still gets an answer", async () => {
    const { host, slot } = await pairingHost();
    const ip = testIp();
    expect(await inOrder(times(4), () => lookupFrom(slot, ip))).toEqual([
      ...times(3).map(() => host.uplink.hostId),
      429,
    ]);
    expect(await lookupFrom(slot, testIp())).toBe(host.uplink.hostId);
  });

  test("a slot admits 10 answered pairing sessions per 10 minutes, then 4429; ordinary sessions are unaffected", async () => {
    const { host, slot } = await pairingHost();
    await inOrder(tenFromFourSources(), (ip) => pairingSession(host, slot, ip, true));
    expect(await closedWith(await dialPairing(host, slot, testIp()))).toBe(CloseCode.RateLimited);
    const ordinary = await connectRelayClient({
      relayUrl: relay.url,
      hostId: host.uplink.hostId,
      createSocket: socketFrom(testIp()),
    });
    defer(() => ordinary.close());
    await host.sessions.take();
    expect(ordinary.closeCode).toBeUndefined();
  });

  test("one source opens at most 3 pairing sessions per slot; another source is still admitted", async () => {
    const { host, slot } = await pairingHost();
    const ip = testIp();
    await inOrder(times(3), () => pairingSession(host, slot, ip, false));
    expect(await closedWith(await dialPairing(host, slot, ip))).toBe(CloseCode.RateLimited);
    expect((await pairingSession(host, slot, testIp(), false)).pairSlot).toBe(slot);
  });

  test("pairing sessions the host never answered are not charged to the slot", async () => {
    const { host, slot } = await pairingHost();
    const sources = times(4).map(() => testIp());
    await inOrder(
      sources.flatMap((ip) => [ip, ip, ip]),
      (ip) => pairingSession(host, slot, ip, false),
    );
    const answered = await pairingSession(host, slot, testIp(), true);
    expect(answered.pairSlot).toBe(slot);
  });

  test("a pairing session to a host that does not hold the slot is closed with 4410", async () => {
    const { host } = await pairingHost();
    expect(await closedWith(await dialPairing(host, uniqueSlot(), testIp()))).toBe(CloseCode.PairSlotUnknown);
  });

  test("a PAIR_SLOT with a readable slot but a bad payload is acked as malformed", async () => {
    const host = await startRawHost(relay.url, testIp());
    const frame = new Uint8Array([MuxType.PairSlot, 0, 0, 0, 0, 0x41, 0x42, 0x33, 1, 2, 3]);
    host.probe.socket.send(frame);
    const ack = await host.frame();
    expect(ack.type === MuxType.PairSlotAck && decodePairSlotAck(ack.payload)).toEqual({
      slot: "AB3",
      status: PairSlotAckStatus.Malformed,
    });
  });
});
