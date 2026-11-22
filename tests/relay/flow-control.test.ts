import {
  ACK_INTERVAL_BYTES,
  CHALLENGE_BYTES,
  ed25519Signer,
  generateSigningKey,
  LinkClosedError,
  Uplink,
  CloseCode,
  connectRelayClient,
  encodeData,
  MAX_SESSION_SEND_BYTES,
  MAX_UNACKED_BYTES,
  MUX_HEADER_BYTES,
  type MuxFrame,
  MuxType,
  RELAY_MESSAGE_CAP,
  type SessionLink,
  type WebSocketLink,
} from "@doriface/relay-client";
import { afterEach, describe, expect, test } from "bun:test";
import { defer, runDeferred } from "./support/cleanup.ts";
import { closedWith, received } from "./support/links.ts";
import { Probe, socketFrom, testIp } from "./support/probe.ts";
import { AsyncQueue } from "./support/queue.ts";
import { startRawHost } from "./support/raw-host.ts";
import { useLocalRelay } from "./support/relay-fixture.ts";
import { inOrder, times } from "./support/sequential.ts";
import { startTestHost, type TestHost } from "./support/test-host.ts";

afterEach(runDeferred);
const relay = useLocalRelay();

const clientUrl = (hostId: string): string => `${relay.url.replace("http", "ws")}/v1/client/${hostId}`;

/** A client session where the client has sent one frame, as every real Noise initiator does first. */
async function openSession(host: TestHost, ip: string): Promise<{ client: WebSocketLink; session: SessionLink }> {
  const client = await connectRelayClient({
    relayUrl: relay.url,
    hostId: host.uplink.hostId,
    createSocket: socketFrom(ip),
  });
  defer(() => client.close());
  const session = await host.sessions.take();
  const first = received(session);
  client.send(new Uint8Array([1]));
  await first.take();
  return { client, session };
}

async function untilClose(next: () => Promise<MuxFrame>, seen: MuxFrame[] = []): Promise<MuxFrame[]> {
  const frame = await next();
  return frame.type === MuxType.Close ? [...seen, frame] : untilClose(next, [...seen, frame]);
}

describe("pending admission (C1)", () => {
  test("a full pending queue evicts the oldest pending session of the source holding the most", async () => {
    const host = await startTestHost(relay.url, testIp());
    const [ipA, ipB, ipC] = [testIp(), testIp(), testIp()];
    const fromA = await inOrder(times(3), () => openSession(host, ipA));
    const fromB = await inOrder(times(5), () => openSession(host, ipB));
    const [oldestB] = fromB;
    if (oldestB === undefined) throw new Error("no sessions from B");
    const clientEvicted = closedWith(oldestB.client);
    const sessionEvicted = closedWith(oldestB.session);

    const newcomer = await openSession(host, ipC);
    expect(await clientEvicted).toBe(CloseCode.RateLimited);
    expect(await sessionEvicted).toBe(CloseCode.RateLimited);
    const kept = [...fromA, ...fromB.slice(1), newcomer];
    expect(kept.map(({ client }) => client.closeCode)).toEqual(kept.map(() => undefined));
    host.uplink.stop();
  });
});

describe("backpressure (C3)", () => {
  test("a client that never acks is closed with 4408 once a legacy uplink sends more than 4 MiB", async () => {
    const ip = testIp();
    const host = await startTestHost(relay.url, ip, { credit: false });
    const probe = new Probe(clientUrl(host.uplink.hostId), ip);
    await probe.opened();
    const session = await host.sessions.take();
    const first = received(session);
    probe.socket.send(new Uint8Array([1]));
    await first.take();
    const sessionClosed = closedWith(session);
    await Promise.all(times(5).map((index) => session.send(new Uint8Array(MAX_SESSION_SEND_BYTES).fill(index))));
    expect((await probe.closed).code).toBe(CloseCode.IdleTimeout);
    expect(await sessionClosed).toBe(CloseCode.IdleTimeout);
    host.uplink.stop();
  });

  test("a credit uplink holds its sends to a client that never acks instead of overrunning it", async () => {
    const ip = testIp();
    const host = await startTestHost(relay.url, ip);
    const probe = new Probe(`${clientUrl(host.uplink.hostId)}?credit=1`, ip);
    await probe.opened();
    const session = await host.sessions.take();
    const first = received(session);
    probe.socket.send(new Uint8Array([1]));
    await first.take();
    const sends = times(5).map((index) => session.send(new Uint8Array(MAX_SESSION_SEND_BYTES).fill(index)));
    expect((await probe.next()).byteLength).toBe(MAX_SESSION_SEND_BYTES);
    expect(probe.socket.readyState).toBe(WebSocket.OPEN);
    host.uplink.stop();
    const outcomes = await Promise.allSettled(sends);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "fulfilled",
      ...times(4).map(() => "rejected" as const),
    ]);
    expect(
      outcomes.slice(1).every((outcome) => outcome.status === "rejected" && outcome.reason instanceof LinkClosedError),
    ).toBe(true);
  });

  test("a client that acks keeps receiving far past 4 MiB", async () => {
    const ip = testIp();
    const host = await startTestHost(relay.url, ip);
    const { client, session } = await openSession(host, ip);
    const atClient = received(client);
    const sizes = await inOrder(times(10), async (index) => {
      await session.send(new Uint8Array(MAX_SESSION_SEND_BYTES).fill(index));
      return (await atClient.take()).byteLength;
    });
    expect(sizes).toEqual(times(10).map(() => MAX_SESSION_SEND_BYTES));
    expect(client.closeCode).toBeUndefined();
    client.close();
    host.uplink.stop();
  });

  test("an uplink that never acks makes the relay close the client that overflows it with 4408", async () => {
    const ip = testIp();
    const host = await startRawHost(relay.url, ip);
    const client = await connectRelayClient({ relayUrl: relay.url, hostId: host.hostId, createSocket: socketFrom(ip) });
    const open = await host.frame();
    expect(open.type).toBe(MuxType.Open);
    // Answered by the host, so its DATA is no longer held to a pending session's first message.
    const atClient = received(client);
    host.probe.socket.send(encodeData(open.sessionId, Uint8Array.of(1)));
    await atClient.take();
    const clientClosed = closedWith(client);
    for (const index of times(5)) client.send(new Uint8Array(MAX_SESSION_SEND_BYTES).fill(index));
    expect(await clientClosed).toBe(CloseCode.IdleTimeout);
    const frames = await untilClose(() => host.frame());
    // The relay counts its own challenge and OPEN against the uplink's window too.
    const forwarded = Math.floor((MAX_UNACKED_BYTES - CHALLENGE_BYTES - MUX_HEADER_BYTES) / RELAY_MESSAGE_CAP);
    expect(frames.map((frame) => frame.type)).toEqual([...times(forwarded).map(() => MuxType.Data), MuxType.Close]);
    expect(frames.at(-1)).toMatchObject({ type: MuxType.Close, code: CloseCode.IdleTimeout });
    host.probe.socket.close();
  });

  test("a client ignoring its credit is closed with 4408 at its window, long before the credit uplink's 4 MiB", async () => {
    const ip = testIp();
    const host = await startRawHost(relay.url, ip, { credit: true });
    const client = new Probe(`${clientUrl(host.hostId)}?credit=1`, ip);
    defer(() => client.socket.close());
    const creditStarted = new Promise<string>((resolve) =>
      client.socket.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (typeof event.data === "string") resolve(event.data);
      }),
    );
    const open = await host.frame();
    expect(open.type).toBe(MuxType.Open);
    expect((await host.frame()).type).toBe(MuxType.Credit);
    expect(await creditStarted).toBe("c:0");
    host.probe.socket.send(encodeData(open.sessionId, Uint8Array.of(1)));
    await client.next();
    // The relay has told this client its window; it sends 5 MiB anyway, as a client ignoring credit would. The first
    // message goes, as any send does below one credit step uncredited; the second is past the 512 KiB window.
    for (const index of times(5)) client.socket.send(new Uint8Array(MAX_SESSION_SEND_BYTES).fill(index));
    expect((await client.closed).code).toBe(CloseCode.IdleTimeout);
    const frames = await untilClose(() => host.frame());
    expect(frames.map((frame) => frame.type)).toEqual([MuxType.Data, MuxType.Close]);
    host.probe.socket.close();
  });

  test("an uplink acks a session's bytes on arrival, even while that session's consumer is busy", async () => {
    const ip = testIp();
    const acks = new AsyncQueue<string>();
    const arrivals = new AsyncQueue<number>();
    const sessions = new AsyncQueue<SessionLink>();
    const answered = Promise.withResolvers<void>();
    const uplink = await Uplink.start({
      relayUrl: relay.url,
      signer: ed25519Signer(generateSigningKey()),
      onSession: (session) => sessions.push(session),
      onState: (state) => {
        if (state.state === "answered") answered.resolve();
      },
      createSocket: (url) => {
        const ws = socketFrom(ip)(url);
        const send = ws.send.bind(ws);
        ws.send = (...args: Parameters<WebSocket["send"]>) => {
          if (typeof args[0] === "string" && args[0].startsWith("a:")) acks.push(args[0]);
          send(...args);
        };
        // Registered after the uplink's own listener, so it sees each message after the uplink handled it.
        queueMicrotask(() =>
          ws.addEventListener("message", (event: MessageEvent<unknown>) => {
            if (event.data instanceof ArrayBuffer) arrivals.push(event.data.byteLength);
          }),
        );
        return ws;
      },
    });
    defer(() => uplink.stop());
    // A client that arrives before the uplink has answered finds the host offline.
    await answered.promise;
    const client = await connectRelayClient({
      relayUrl: relay.url,
      hostId: uplink.hostId,
      createSocket: socketFrom(ip),
    });
    defer(() => client.close());
    const session = await sessions.take();
    const consumed = Promise.withResolvers<void>();
    session.onData(() => consumed.promise);
    client.send(new Uint8Array(ACK_INTERVAL_BYTES));
    const dataArrived = async (): Promise<void> => {
      if ((await arrivals.take()) !== MUX_HEADER_BYTES + ACK_INTERVAL_BYTES) return dataArrived();
    };
    await dataArrived();
    expect(await acks.take()).toMatch(/^a:\d+$/);
    consumed.resolve();
    client.close();
    uplink.stop();
  });

  test("an ack for bytes the relay never sent closes the socket with 4402", async () => {
    const ip = testIp();
    const host = await startTestHost(relay.url, ip);
    const probe = new Probe(clientUrl(host.uplink.hostId), ip);
    await probe.opened();
    probe.socket.send("a:65536");
    expect((await probe.closed).code).toBe(CloseCode.RelayProtocolError);
    host.uplink.stop();
  });
});
