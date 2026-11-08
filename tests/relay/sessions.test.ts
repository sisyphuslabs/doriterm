import {
  CloseCode,
  connectRelayClient,
  MAX_SESSION_SEND_BYTES,
  type SessionLink,
  type WebSocketLink,
} from "@doriface/relay-client";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { runDeferred } from "./support/cleanup.ts";
import { closedWith, received } from "./support/links.ts";
import { Probe, socketFrom, testIp } from "./support/probe.ts";
import { inOrder, times } from "./support/sequential.ts";
import { type LocalRelay, startLocalRelay, RELAY_STOP_MS } from "./support/relay-dev.ts";
import { startTestHost } from "./support/test-host.ts";
import { setUpOnce } from "./support/set-up-once.ts";

let relay: LocalRelay;

setUpOnce(async () => {
  relay = await startLocalRelay();
}, 120_000);

afterAll(() => relay?.stop(), RELAY_STOP_MS);

afterEach(runDeferred);

const clientUrl = (hostId: string): string => `${relay.url.replace("http", "ws")}/v1/client/${hostId}`;

describe("client sessions through the relay", () => {
  test("a client to an offline host is closed with 4404", async () => {
    const probe = new Probe(clientUrl("a".repeat(26)), testIp());
    expect((await probe.closed).code).toBe(CloseCode.HostOffline);
  });

  test("random bytes round-trip byte-exact in both directions", async () => {
    const ip = testIp();
    const host = await startTestHost(relay.url, ip);
    const client = await connectRelayClient({
      relayUrl: relay.url,
      hostId: host.uplink.hostId,
      createSocket: socketFrom(ip),
    });
    const session = await host.sessions.take();
    const atHost = received(session);
    const atClient = received(client);
    const sizes = [1, 7, 1024, 65_535, 65_536, 300_000, MAX_SESSION_SEND_BYTES];
    await inOrder(sizes, async (size) => {
      const up = crypto.getRandomValues(new Uint8Array(size));
      const down = crypto.getRandomValues(new Uint8Array(size));
      client.send(up);
      await session.send(down);
      expect(await atHost.take()).toEqual(up);
      expect(await atClient.take()).toEqual(down);
    });
    // The largest client message is the largest host payload, so every uplink frame stays within the 1 MiB cap.
    const capped = new Uint8Array(MAX_SESSION_SEND_BYTES).fill(7);
    client.send(capped);
    expect(await atHost.take()).toEqual(capped);
    const burst = Array.from({ length: 200 }, (_, i) => crypto.getRandomValues(new Uint8Array(1 + i)));
    for (const bytes of burst) client.send(bytes);
    expect(await inOrder(burst, () => atHost.take())).toEqual(burst);

    const sessionClosed = closedWith(session);
    client.close();
    expect(await sessionClosed).toBe(CloseCode.Normal);
    host.uplink.stop();
  });

  test("a best-of-three dial keeps one of its three sessions and closes the other two before they carry a byte", async () => {
    const ip = testIp();
    const host = await startTestHost(relay.url, ip);
    const client = await connectRelayClient({
      relayUrl: relay.url,
      hostId: host.uplink.hostId,
      createSocket: socketFrom(ip),
      bestOf: 3,
    });
    const sessions = await inOrder(times(3), () => host.sessions.take());
    const carrier = Promise.withResolvers<number>();
    const carried: number[] = [];
    sessions.forEach((session, index) =>
      session.onData(() => {
        carried.push(index);
        carrier.resolve(index);
      }),
    );
    const up = crypto.getRandomValues(new Uint8Array(1024));
    const kept = sessions[await (client.send(up), carrier.promise)];
    if (kept === undefined) throw new Error("no session carried the client's bytes");
    const atHost = received(kept);
    const atClient = received(client);
    const down = crypto.getRandomValues(new Uint8Array(2048));
    await kept.send(down);
    expect(await atClient.take()).toEqual(down);
    client.send(up);
    expect(await atHost.take()).toEqual(up);
    const losers = sessions.filter((session) => session !== kept);
    expect(await Promise.all(losers.map(closedWith))).toEqual([CloseCode.Normal, CloseCode.Normal]);
    expect(new Set(carried)).toEqual(new Set([sessions.indexOf(kept)]));
    host.uplink.stop();
  }, 30_000);

  test("a host closing a session closes the client socket", async () => {
    const ip = testIp();
    const host = await startTestHost(relay.url, ip);
    const client = await connectRelayClient({
      relayUrl: relay.url,
      hostId: host.uplink.hostId,
      createSocket: socketFrom(ip),
    });
    const session = await host.sessions.take();
    // Like a real initiator's Noise msg1. workerd delays the TCP close of a hibernatable socket that has not sent a
    // data frame by ~10 s (cloudflare/workerd#7566), which only shows locally.
    const first = received(session);
    client.send(new Uint8Array([1]));
    await first.take();
    const clientClosed = closedWith(client);
    session.close();
    expect(await clientClosed).toBe(CloseCode.Normal);
    host.uplink.stop();
  });

  test("the 33rd active client is refused with 4429 and a freed slot is reusable", async () => {
    const ip = testIp();
    const host = await startTestHost(relay.url, ip);
    // A session counts against the cap once the host has sent DATA on it (contract v1.2 C1).
    const connectActive = async (): Promise<{ client: WebSocketLink; session: SessionLink }> => {
      const client = await connectRelayClient({
        relayUrl: relay.url,
        hostId: host.uplink.hostId,
        createSocket: socketFrom(ip),
      });
      const session = await host.sessions.take();
      const atClient = received(client);
      await session.send(new Uint8Array([1]));
      await atClient.take();
      return { client, session };
    };
    const active = await inOrder(times(32), connectActive);
    expect(new Set(active.map(({ session }) => session.sessionId)).size).toBe(32);
    expect(active.every(({ client }) => client.closeCode === undefined)).toBe(true);

    const refused = await connectRelayClient({
      relayUrl: relay.url,
      hostId: host.uplink.hostId,
      createSocket: socketFrom(ip),
    });
    expect(await closedWith(refused)).toBe(CloseCode.RateLimited);

    const [first] = active;
    if (first === undefined) throw new Error("no sessions");
    const released = closedWith(first.session);
    first.client.close();
    await released;
    const again = await connectActive();
    expect(again.client.closeCode).toBeUndefined();
    host.uplink.stop();
  });

  test("a client message whose uplink frame would exceed 1 MiB is rejected with 1009", async () => {
    const ip = testIp();
    const host = await startTestHost(relay.url, ip);
    const probe = new Probe(clientUrl(host.uplink.hostId), ip);
    await probe.opened();
    const session = await host.sessions.take();
    const sessionClosed = closedWith(session);
    probe.socket.send(new Uint8Array(MAX_SESSION_SEND_BYTES + 1));
    expect((await probe.closed).code).toBe(CloseCode.MessageTooBig);
    expect(await sessionClosed).toBe(CloseCode.MessageTooBig);
    host.uplink.stop();
  });

  test("connections over the per-IP rate are refused with 4429", async () => {
    // The relay admits 60 upgrades per address per minute, in windows aligned to the wall clock. The 61 dials go out at
    // once, so the wall time does not grow with a loaded runner, and exactly one of them is over the rate. A burst that
    // spans a window boundary is counted in two windows and proves nothing: it is dialed again from a fresh address,
    // which then starts just after that boundary.
    const burst = async (): Promise<number[] | undefined> => {
      const ip = testIp();
      const window = Math.floor(Date.now() / 60_000);
      const codes = await Promise.all(
        times(61).map(async () => (await new Probe(clientUrl(`${"b".repeat(25)}a`), ip).closed).code),
      );
      return Math.floor(Date.now() / 60_000) === window ? codes : undefined;
    };
    const codes = (await burst()) ?? (await burst());
    if (codes === undefined) throw new Error("two bursts in a row spanned a rate window boundary");
    expect(codes.toSorted((a, b) => a - b)).toEqual([
      ...Array.from({ length: 60 }, () => CloseCode.HostOffline),
      CloseCode.RateLimited,
    ]);
    expect((await new Probe(clientUrl(`${"b".repeat(25)}a`), testIp()).closed).code).toBe(CloseCode.HostOffline);
    // One burst took 0.5-3.1 s (median ~1.1 s) over 91 runs on runners loaded to 1.3-2.9x their cores; the budget covers
    // two bursts at that worst case with more than 2x to spare.
  }, 15_000);
});
