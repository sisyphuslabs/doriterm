import {
  CloseCode,
  connectRelayClient,
  ed25519Signer,
  generateSigningKey,
  hostIdOf,
  type SessionLink,
  type WebSocketLink,
} from "@doriface/relay-client";
import { afterEach, describe, expect, test } from "bun:test";
import { defer, runDeferred } from "./support/cleanup.ts";
import { closedWith, received } from "./support/links.ts";
import { Probe, socketFrom, testIp } from "./support/probe.ts";
import { startRawHost } from "./support/raw-host.ts";
import { useLocalRelay } from "./support/relay-fixture.ts";
import { startTestHost, type TestHost } from "./support/test-host.ts";

// Short deadlines so the reaper runs within a test; production uses 10 s and 90 s.
const PENDING_TIMEOUT_MS = 1_000;
const IDLE_TIMEOUT_MS = 2_000;
const AUTH_TIMEOUT_MS = 1_000;
const FAST_PING_MS = 300;
const NO_PING_MS = 600_000;

const relay = useLocalRelay({
  PENDING_TIMEOUT_MS: String(PENDING_TIMEOUT_MS),
  IDLE_TIMEOUT_MS: String(IDLE_TIMEOUT_MS),
  AUTH_TIMEOUT_MS: String(AUTH_TIMEOUT_MS),
});

afterEach(runDeferred);

interface Session {
  readonly client: WebSocketLink;
  readonly session: SessionLink;
}

async function connect(host: TestHost, ip: string, pingIntervalMs: number): Promise<Session> {
  const client = await connectRelayClient({
    relayUrl: relay.url,
    hostId: host.uplink.hostId,
    createSocket: socketFrom(ip),
    pingIntervalMs,
  });
  defer(() => client.close());
  const session = await host.sessions.take();
  const first = received(session);
  client.send(new Uint8Array([1]));
  await first.take();
  return { client, session };
}

async function activate({ client, session }: Session): Promise<void> {
  const atClient = received(client);
  await session.send(new Uint8Array([2]));
  await atClient.take();
}

async function roundTrips({ client, session }: Session): Promise<boolean> {
  const atHost = received(session);
  client.send(new Uint8Array([3]));
  return (await atHost.take())[0] === 3;
}

describe("keepalive and reaping (C1, C6)", () => {
  test("ping is answered with pong", async () => {
    const ws = socketFrom(testIp())(`${relay.url.replace("http", "ws")}/v1/host/${"d".repeat(25)}a`);
    const pong = new Promise<unknown>((resolve) => {
      ws.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (typeof event.data === "string") resolve(event.data);
      });
    });
    ws.addEventListener("open", () => ws.send("ping"), { once: true });
    expect(await pong).toBe("pong");
    ws.close();
  });

  test("a session without host DATA in time is closed with 4408; an activated one stays", async () => {
    const ip = testIp();
    const host = await startTestHost(relay.url, ip, { pingIntervalMs: FAST_PING_MS });
    const active = await connect(host, ip, FAST_PING_MS);
    await activate(active);
    const silent = await connect(host, ip, FAST_PING_MS);
    const silentClient = closedWith(silent.client);
    const silentSession = closedWith(silent.session);
    expect(await silentClient).toBe(CloseCode.IdleTimeout);
    expect(await silentSession).toBe(CloseCode.IdleTimeout);
    expect(active.client.closeCode).toBeUndefined();
    expect(await roundTrips(active)).toBe(true);
    host.uplink.stop();
  });

  test("a client that stops pinging is reaped with 4408; a pinging one is not", async () => {
    const ip = testIp();
    const host = await startTestHost(relay.url, ip, { pingIntervalMs: FAST_PING_MS });
    const pinging = await connect(host, ip, FAST_PING_MS);
    await activate(pinging);
    const quiet = await connect(host, ip, NO_PING_MS);
    await activate(quiet);
    expect(await closedWith(quiet.client)).toBe(CloseCode.IdleTimeout);
    expect(await closedWith(quiet.session)).toBe(CloseCode.IdleTimeout);
    expect(pinging.client.closeCode).toBeUndefined();
    expect(await roundTrips(pinging)).toBe(true);
    host.uplink.stop();
  });

  test("reaping an uplink that never authenticated leaves the online host's sessions alone", async () => {
    const ip = testIp();
    const host = await startTestHost(relay.url, ip, { pingIntervalMs: FAST_PING_MS });
    const pinging = await connect(host, ip, FAST_PING_MS);
    await activate(pinging);
    const stray = new Probe(`${relay.url.replace("http", "ws")}/v1/host/${host.uplink.hostId}`, ip);
    defer(() => stray.socket.close());
    await stray.next();
    // Opened after the stray socket, so its reaping proves the reaper has passed the stray socket's deadline.
    const quiet = await connect(host, ip, NO_PING_MS);
    await activate(quiet);
    expect(await closedWith(quiet.client)).toBe(CloseCode.IdleTimeout);
    expect(pinging.client.closeCode).toBeUndefined();
    expect(await roundTrips(pinging)).toBe(true);
    host.uplink.stop();
  });

  test("an uplink that stops pinging is reaped with 4408 and its host goes offline", async () => {
    const ip = testIp();
    const pinging = await startTestHost(relay.url, ip, { pingIntervalMs: FAST_PING_MS });
    const quiet = await startRawHost(relay.url, ip);
    expect((await quiet.probe.closed).code).toBe(CloseCode.IdleTimeout);
    const toQuiet = await connectRelayClient({
      relayUrl: relay.url,
      hostId: quiet.hostId,
      createSocket: socketFrom(ip),
    });
    expect(await closedWith(toQuiet)).toBe(CloseCode.HostOffline);
    expect(pinging.states.map(({ state }) => state)).toEqual(["connecting", "answered"]);
    const session = await connect(pinging, ip, FAST_PING_MS);
    await activate(session);
    expect(await roundTrips(session)).toBe(true);
    pinging.uplink.stop();
  });

  test("a client to an offline host waits for the uplinks authenticating when it came, not for later ones", async () => {
    const ip = testIp();
    const hostId = await hostIdOf(ed25519Signer(generateSigningKey()).publicKey);
    let strays = 0;
    const openStray = async (): Promise<void> => {
      const stray = new Probe(`${relay.url.replace("http", "ws")}/v1/host/${hostId}`, ip);
      defer(() => stray.socket.close());
      await stray.next();
      strays += 1;
    };
    await openStray();
    let settled = false;
    const closed = connectRelayClient({ relayUrl: relay.url, hostId, createSocket: socketFrom(ip) }).then(closedWith);
    void closed.finally(() => {
      settled = true;
    });
    // Unanswered uplinks keep arriving; time is the behavior here, one every third of the auth timeout.
    const keepComing = async (left: number): Promise<void> => {
      if (settled || left === 0) return;
      await Bun.sleep(AUTH_TIMEOUT_MS / 3);
      await openStray();
      return keepComing(left - 1);
    };
    await keepComing(9);
    expect(await closed).toBe(CloseCode.HostOffline);
    expect(strays).toBeLessThanOrEqual(5);
  });
});
