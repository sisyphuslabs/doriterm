import {
  authMessage,
  CloseCode,
  connectRelayClient,
  CROCKFORD_ALPHABET,
  decodeMux,
  decodePairSlotAck,
  ed25519Signer,
  encodeAuthAnswer,
  encodePairSlotRequest,
  generateSigningKey,
  hostIdOf,
  MuxType,
  PairSlotAckStatus,
  RelayCloseError,
  relayOriginOf,
  Uplink,
} from "@doriface/relay-client";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { defer, runDeferred } from "./support/cleanup.ts";
import { type Closed, Probe, socketFrom, testIp } from "./support/probe.ts";
import { type LocalRelay, startLocalRelay } from "./support/relay-dev.ts";
import { startTestHost } from "./support/test-host.ts";
import { setUpOnce } from "./support/set-up-once.ts";

let relay: LocalRelay;

setUpOnce(async () => {
  relay = await startLocalRelay();
}, 120_000);

afterAll(() => relay?.stop());

afterEach(runDeferred);

const hostUrl = (hostId: string): string => `${relay.url.replace("http", "ws")}/v1/host/${hostId}`;

async function answerWith(hostId: string, answer: (challenge: Uint8Array) => Promise<Uint8Array>): Promise<Closed> {
  const probe = new Probe(hostUrl(hostId), testIp());
  const challenge = await probe.next();
  expect(challenge.byteLength).toBe(32);
  probe.socket.send(await answer(challenge));
  return probe.closed;
}

describe("host challenge auth", () => {
  test("healthz reports the relay version", async () => {
    // A v1.6 relay may add its pass state (`passes`, `kid`, `accepted`); stand-ins need not.
    expect(await (await fetch(`${relay.url}/healthz`)).json()).toMatchObject({ ok: true, version: "0.0.0" });
  });

  test("a correctly signed answer brings the host online for clients", async () => {
    const ip = testIp();
    const host = await startTestHost(relay.url, ip);
    const client = await connectRelayClient({
      relayUrl: relay.url,
      hostId: host.uplink.hostId,
      createSocket: socketFrom(ip),
    });
    const session = await host.sessions.take();
    expect(session.sessionId).toBeGreaterThanOrEqual(0);
    expect(client.closeCode).toBeUndefined();
    client.close();
    host.uplink.stop();
    expect(await host.uplink.stopped).toBe(CloseCode.Normal);
  });

  test("a bad signature is closed with 4403", async () => {
    const signer = ed25519Signer(generateSigningKey());
    const hostId = await hostIdOf(signer.publicKey);
    const closed = await answerWith(hostId, async () =>
      encodeAuthAnswer(signer.publicKey, crypto.getRandomValues(new Uint8Array(64))),
    );
    expect(closed.code).toBe(CloseCode.RelayAuthFailed);
  });

  test("a key that does not hash to the hostId is closed with 4403", async () => {
    const signer = ed25519Signer(generateSigningKey());
    const otherId = await hostIdOf(ed25519Signer(generateSigningKey()).publicKey);
    const origin = relayOriginOf(hostUrl(otherId));
    const closed = await answerWith(otherId, async (challenge) =>
      encodeAuthAnswer(signer.publicKey, await signer.sign(authMessage(origin, otherId, challenge))),
    );
    expect(closed.code).toBe(CloseCode.RelayAuthFailed);
  });

  test("a signature over another relay's origin is closed with 4403", async () => {
    const signer = ed25519Signer(generateSigningKey());
    const hostId = await hostIdOf(signer.publicKey);
    const closed = await answerWith(hostId, async (challenge) =>
      encodeAuthAnswer(
        signer.publicKey,
        await signer.sign(authMessage("wss://other-relay.example", hostId, challenge)),
      ),
    );
    expect(closed.code).toBe(CloseCode.RelayAuthFailed);
  });

  test("a PAIR_SLOT sent right behind the answer waits for verification instead of failing auth", async () => {
    const signer = ed25519Signer(generateSigningKey());
    const hostId = await hostIdOf(signer.publicKey);
    const probe = new Probe(hostUrl(hostId), testIp());
    defer(() => probe.socket.close());
    const challenge = await probe.next();
    const signature = await signer.sign(authMessage(relayOriginOf(hostUrl(hostId)), hostId, challenge));
    const slot = [...crypto.getRandomValues(new Uint8Array(3))]
      .map((byte) => CROCKFORD_ALPHABET.charAt(byte & 31))
      .join("");
    probe.socket.send(encodeAuthAnswer(signer.publicKey, signature));
    probe.socket.send(encodePairSlotRequest(slot, new Uint8Array(32).fill(5)));
    const reply = decodeMux(await probe.next());
    expect(reply.type === MuxType.PairSlotAck && decodePairSlotAck(reply.payload)).toEqual({
      slot,
      status: PairSlotAckStatus.Registered,
    });
  });

  test("an uplink stops for good on 4403", async () => {
    const signer = ed25519Signer(generateSigningKey());
    const wrong = ed25519Signer(generateSigningKey());
    const uplink = await Uplink.start({
      relayUrl: relay.url,
      signer: { publicKey: signer.publicKey, sign: (message) => wrong.sign(message) },
      createSocket: socketFrom(testIp()),
      onSession: () => {},
    });
    expect(await uplink.stopped).toBe(CloseCode.RelayAuthFailed);
  });

  test("an uplink stopped while connecting closes its socket and never comes online", async () => {
    const ip = testIp();
    const sockets: WebSocket[] = [];
    const sessions: unknown[] = [];
    const uplink = await Uplink.start({
      relayUrl: relay.url,
      signer: ed25519Signer(generateSigningKey()),
      createSocket: (url) => {
        const ws = socketFrom(ip)(url);
        sockets.push(ws);
        return ws;
      },
      onSession: (session) => sessions.push(session),
    });
    uplink.stop();
    const [ws] = sockets;
    if (ws === undefined) throw new Error("the uplink opened no socket");
    await new Promise((resolve) => ws.addEventListener("close", resolve, { once: true }));
    const client = await connectRelayClient({
      relayUrl: relay.url,
      hostId: uplink.hostId,
      createSocket: socketFrom(ip),
    });
    const closed = await new Promise<Error | undefined>((resolve) => client.onClose(resolve));
    expect(closed instanceof RelayCloseError ? closed.code : closed).toBe(CloseCode.HostOffline);
    expect(sockets).toHaveLength(1);
    expect(sessions).toHaveLength(0);
  });

  test("a newer uplink for the same host replaces the old one and ends its sessions", async () => {
    const ip = testIp();
    const first = await startTestHost(relay.url, ip);
    const hostId = first.uplink.hostId;
    const oldClient = await connectRelayClient({ relayUrl: relay.url, hostId, createSocket: socketFrom(ip) });
    const oldSession = await first.sessions.take();
    // A client that has sent a frame, as every real one has; see workerd#7566 in sessions.test.ts.
    const hello = new Promise<Uint8Array>((resolve) => oldSession.onData(resolve));
    oldClient.send(new Uint8Array([1]));
    await hello;
    const oldSessionClosed = new Promise<Error | undefined>((resolve) => oldSession.onClose(resolve));
    const oldClientClosed = new Promise<Error | undefined>((resolve) => oldClient.onClose(resolve));

    const second = await startTestHost(relay.url, ip, { secretKey: first.secretKey });
    expect(await first.uplink.stopped).toBe(CloseCode.UplinkReplaced);
    expect(await oldSessionClosed).toBeInstanceOf(RelayCloseError);
    const clientError = await oldClientClosed;
    expect(clientError instanceof RelayCloseError ? clientError.code : undefined).toBe(CloseCode.HostOffline);

    const newClient = await connectRelayClient({ relayUrl: relay.url, hostId, createSocket: socketFrom(ip) });
    const newSession = await second.sessions.take();
    const payload = crypto.getRandomValues(new Uint8Array(64));
    const received = new Promise<Uint8Array>((resolve) => newSession.onData(resolve));
    newClient.send(payload);
    expect(await received).toEqual(payload);
    expect(first.sessions.size).toBe(0);
    newClient.close();
    second.uplink.stop();
  });
});
