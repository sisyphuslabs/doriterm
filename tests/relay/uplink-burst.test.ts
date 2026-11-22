import {
  ACK_INTERVAL_BYTES,
  CHALLENGE_BYTES,
  CloseCode,
  encodeData,
  MAX_SESSION_SEND_BYTES,
  MAX_UNACKED_BYTES,
  MUX_HEADER_BYTES,
  type MuxFrame,
  MuxType,
  RELAY_MESSAGE_CAP,
  SESSION_WINDOW_BYTES,
} from "@doriface/relay-client";
import { afterEach, describe, expect, test } from "bun:test";
import { defer, runDeferred } from "./support/cleanup.ts";
import { Probe, testIp } from "./support/probe.ts";
import { type RawHost, startRawHost } from "./support/raw-host.ts";
import { useLocalRelay } from "./support/relay-fixture.ts";
import { inOrder, times } from "./support/sequential.ts";

const relay = useLocalRelay();

afterEach(runDeferred);

const clientUrl = (hostId: string): string => `${relay.url.replace("http", "ws")}/v1/client/${hostId}`;

/** The relay's own frames on an uplink: OPEN without a slot, and the zero CREDIT a credit uplink gets after it. */
const OPEN_BYTES = MUX_HEADER_BYTES;
const CREDIT_BYTES = MUX_HEADER_BYTES + 4;
/** Room the relay keeps above the 4 MiB DATA window for its own frames (contract v1.7.1). */
const CONTROL_RESERVE = ACK_INTERVAL_BYTES;
/** A session with at most this many bytes unacked on the uplink, its write included, is light (#293). */
const LIGHT_SESSION_BYTES = 16 * 1024;

interface Session {
  readonly id: number;
  readonly client: Probe;
}

interface Credit {
  /** The uplink dialed with `?credit=1`, so the relay sends it a zero CREDIT after each OPEN. */
  readonly host: boolean;
  readonly client: boolean;
}

/** A client the host has answered, so it is active: the host's first DATA reaches it as one byte, `mark`. */
async function answered(host: RawHost, ip: string, mark: number, credit: Credit): Promise<Session> {
  const client = new Probe(`${clientUrl(host.hostId)}${credit.client ? "?credit=1" : ""}`, ip);
  defer(() => client.socket.close());
  await client.opened();
  const open = await host.frame();
  if (open.type !== MuxType.Open) throw new Error(`expected OPEN, got ${open.type}`);
  if (credit.host) expect(await host.frame()).toMatchObject({ type: MuxType.Credit, sessionId: open.sessionId });
  host.probe.socket.send(encodeData(open.sessionId, Uint8Array.of(mark)));
  expect(Array.from(await client.next())).toEqual([mark]);
  return { id: open.sessionId, client };
}

const LEGACY: Credit = { host: false, client: false };
const CREDIT_HOST: Credit = { host: true, client: false };
const BOTH_CREDIT: Credit = { host: true, client: true };

async function dataFrames(host: RawHost, count: number, seen: MuxFrame[] = []): Promise<MuxFrame[]> {
  if (seen.length === count) return seen;
  const frame = await host.frame();
  expect(frame.type).toBe(MuxType.Data);
  return dataFrames(host, count, [...seen, frame]);
}

/**
 * How far a session past its light bytes may fill the uplink's DATA window: a light write's room is left for each of
 * the `others` live sessions, and for at least one (#293).
 */
const heavyEdge = (others: number): number => MAX_UNACKED_BYTES - LIGHT_SESSION_BYTES * Math.max(1, others);

/**
 * Sends DATA from `senders`, a full message at a time in turn, until the uplink, which never acks, is 2 bytes short
 * of `edge` (the whole 4 MiB window unless given): too short for any relay frame (OPEN 5 bytes, CLOSE 7, CREDIT 9) or
 * a DATA frame.
 */
async function fillToTheEdge(
  host: RawHost,
  senders: readonly Session[],
  counted: number,
  edge = MAX_UNACKED_BYTES,
): Promise<void> {
  const room = edge - 2 - counted;
  const full = Math.floor(room / RELAY_MESSAGE_CAP);
  const sizes = [...times(full).map(() => MAX_SESSION_SEND_BYTES), room - full * RELAY_MESSAGE_CAP - MUX_HEADER_BYTES];
  sizes.forEach((size, index) => senders[index % senders.length]?.client.socket.send(new Uint8Array(size)));
  await dataFrames(host, sizes.length);
}

const uplinkOpen = (host: RawHost): boolean => host.probe.socket.readyState === WebSocket.OPEN;

describe("an uplink whose window sessions have filled (#42)", () => {
  test("one session's DATA past the window ends that session only; the uplink takes its CLOSE and a new OPEN", async () => {
    const ip = testIp();
    const host = await startRawHost(relay.url, ip);
    const filler = await answered(host, ip, 1, LEGACY);
    // Alone on the uplink, it may still fill all but one light write's room.
    await fillToTheEdge(host, [filler], CHALLENGE_BYTES + OPEN_BYTES, heavyEdge(0));

    filler.client.socket.send(Uint8Array.of(9));
    expect((await filler.client.closed).code).toBe(CloseCode.IdleTimeout);
    expect(await host.frame()).toEqual({ type: MuxType.Close, sessionId: filler.id, code: CloseCode.IdleTimeout });

    const next = await answered(host, ip, 2, LEGACY);
    expect(next.client.socket.readyState).toBe(WebSocket.OPEN);
    expect(uplinkOpen(host)).toBe(true);
  });

  test("a burst across sessions ends only a heavy session that does not fit; a light one, OPEN, CLOSE and CREDIT go on", async () => {
    const ip = testIp();
    const host = await startRawHost(relay.url, ip, { credit: true });
    const sessions = await inOrder(times(5), (index) => answered(host, ip, index + 1, CREDIT_HOST));
    const [first, ...rest] = sessions;
    const late = rest.at(-1);
    if (first === undefined || late === undefined) throw new Error("five sessions");
    const fillers = sessions.slice(0, 4);
    const counted = CHALLENGE_BYTES + sessions.length * (OPEN_BYTES + CREDIT_BYTES);
    await fillToTheEdge(host, fillers, counted, heavyEdge(4));

    // A filler's next write does not fit its share: that session ends alone.
    first.client.socket.send(new Uint8Array(3));
    expect((await first.client.closed).code).toBe(CloseCode.IdleTimeout);
    expect(await host.frame()).toEqual({ type: MuxType.Close, sessionId: first.id, code: CloseCode.IdleTimeout });
    // The light session's keystroke still reaches the host.
    late.client.socket.send(Uint8Array.of(9));
    expect(await host.frame()).toEqual({ type: MuxType.Data, sessionId: late.id, payload: Uint8Array.of(9) });
    const [second] = rest;
    if (second === undefined) throw new Error("a second session");

    // The second session acks the byte the host sent it: a credit uplink gets that as CREDIT.
    second.client.socket.send("a:1");
    expect(await host.frame()).toEqual({ type: MuxType.Credit, sessionId: second.id, bytes: 1 });

    const newcomer = await answered(host, ip, 7, CREDIT_HOST);
    await Promise.all(
      fillers.slice(1).map(async (session, index) => {
        host.probe.socket.send(encodeData(session.id, Uint8Array.of(20 + index)));
        expect(Array.from(await session.client.next())).toEqual([20 + index]);
      }),
    );
    expect(newcomer.client.socket.readyState).toBe(WebSocket.OPEN);
    expect(uplinkOpen(host)).toBe(true);
  });
});

describe("a light session beside one that fills the window (#293)", () => {
  test("one session fills the uplink's window; another session's 1-byte write still reaches the host", async () => {
    const ip = testIp();
    const host = await startRawHost(relay.url, ip);
    const filler = await answered(host, ip, 1, LEGACY);
    const typist = await answered(host, ip, 2, LEGACY);
    // What fills the window to 2 bytes short of 4 MiB, too short for the typist's frame if the filler were let in.
    const room = MAX_UNACKED_BYTES - 2 - CHALLENGE_BYTES - 2 * OPEN_BYTES;
    const full = Math.floor(room / RELAY_MESSAGE_CAP);
    const sizes = [
      ...times(full).map(() => MAX_SESSION_SEND_BYTES),
      room - full * RELAY_MESSAGE_CAP - MUX_HEADER_BYTES,
    ];
    for (const size of sizes) filler.client.socket.send(new Uint8Array(size));
    // Every message reaches the host, or the filler is ended where it passes its share, alone.
    const untilFilled = async (left: number): Promise<void> => {
      if (left === 0) return;
      const frame = await host.frame();
      if (frame.type === MuxType.Data) return untilFilled(left - 1);
      expect(frame).toEqual({ type: MuxType.Close, sessionId: filler.id, code: CloseCode.IdleTimeout });
    };
    await untilFilled(sizes.length);

    typist.client.socket.send(Uint8Array.of(9));
    expect(await host.frame()).toEqual({ type: MuxType.Data, sessionId: typist.id, payload: Uint8Array.of(9) });
    expect(typist.client.socket.readyState).toBe(WebSocket.OPEN);
    expect(uplinkOpen(host)).toBe(true);
  });
});

describe("the relay frames' reserve (#42)", () => {
  test("a client acking a byte at a time cannot fill the reserve: its acks reach the host as one CREDIT a step", async () => {
    const ip = testIp();
    const host = await startRawHost(relay.url, ip, { credit: true });
    const [acker, filler, other] = await inOrder(times(3), (index) => answered(host, ip, index + 1, CREDIT_HOST));
    if (acker === undefined || filler === undefined || other === undefined) throw new Error("three sessions");
    host.probe.socket.send(encodeData(acker.id, new Uint8Array(ACK_INTERVAL_BYTES)));
    await acker.client.next();
    await fillToTheEdge(host, [filler], CHALLENGE_BYTES + 3 * (OPEN_BYTES + CREDIT_BYTES), heavyEdge(2));
    // The two light sessions take the last two light writes' room: the window is 2 bytes short of full.
    for (const light of [acker, other])
      light.client.socket.send(new Uint8Array(LIGHT_SESSION_BYTES - MUX_HEADER_BYTES));
    await dataFrames(host, 2);
    // One ack per byte, as many as would overrun the reserve if each became a CREDIT, then one that catches up.
    const tiny = Math.ceil(CONTROL_RESERVE / CREDIT_BYTES) + 1;
    for (const total of times(tiny)) acker.client.socket.send(`a:${total + 2}`);
    acker.client.socket.send(`a:${ACK_INTERVAL_BYTES + 1}`);
    expect(await host.frame()).toEqual({ type: MuxType.Credit, sessionId: acker.id, bytes: ACK_INTERVAL_BYTES + 1 });
    host.probe.socket.send(encodeData(other.id, Uint8Array.of(9)));
    expect(Array.from(await other.client.next())).toEqual([9]);
    expect(uplinkOpen(host)).toBe(true);
    // Thousands of acks, one message each: a loaded runner needs more than the default 5 s.
  }, 30_000);

  test("an uplink that acks nothing until even its 64 KiB reserve is used is closed with 4408", async () => {
    const ip = testIp();
    const host = await startRawHost(relay.url, ip, { credit: true });
    const [acker, filler] = await inOrder(times(2), (index) => answered(host, ip, index + 1, CREDIT_HOST));
    if (acker === undefined || filler === undefined) throw new Error("two sessions");
    await fillToTheEdge(host, [filler], CHALLENGE_BYTES + 2 * (OPEN_BYTES + CREDIT_BYTES), heavyEdge(1));
    // The acker, light, takes the last light write's room: the window is 2 bytes short of full.
    acker.client.socket.send(new Uint8Array(LIGHT_SESSION_BYTES - MUX_HEADER_BYTES));
    await dataFrames(host, 1);
    // The host paces it: one byte to the client, whose ack of everything sent becomes one 9-byte CREDIT, and so on.
    const credits = Math.ceil(CONTROL_RESERVE / CREDIT_BYTES) + 1;
    // Once the uplink is closed the client's read fails too (4404): either failure ends the loop.
    const step = async (sent: number): Promise<boolean> => {
      if (!uplinkOpen(host)) return false;
      host.probe.socket.send(encodeData(acker.id, Uint8Array.of(sent % 256)));
      const read = await acker.client.next().then(
        () => true,
        () => false,
      );
      if (!read) return false;
      acker.client.socket.send(`a:${sent + 1}`);
      return (
        (await host.frame().then(
          () => true,
          () => false,
        )) && sent < credits
      );
    };
    const run = async (sent: number): Promise<void> => {
      if (await step(sent)) return run(sent + 1);
    };
    await run(1);
    expect((await host.probe.closed).code).toBe(CloseCode.IdleTimeout);
  }, 120_000);
});

describe("per-session bounds before the shared window (#42)", () => {
  test("a pending session may send one credit step before the host answers; a byte more ends it alone", async () => {
    const ip = testIp();
    const host = await startRawHost(relay.url, ip);
    // Opened one after the other, so each OPEN on the uplink is known to be that client's.
    const pendingClient = async (): Promise<Session> => {
      const client = new Probe(clientUrl(host.hostId), ip);
      defer(() => client.socket.close());
      await client.opened();
      const open = await host.frame();
      if (open.type !== MuxType.Open) throw new Error(`expected OPEN, got ${open.type}`);
      return { id: open.sessionId, client };
    };
    const { id: flooderId, client: flooder } = await pendingClient();
    const { client: quiet } = await pendingClient();

    flooder.socket.send(new Uint8Array(ACK_INTERVAL_BYTES - 1));
    flooder.socket.send(Uint8Array.of(1));
    expect(await dataFrames(host, 2)).toMatchObject([{ sessionId: flooderId }, { sessionId: flooderId }]);
    flooder.socket.send(Uint8Array.of(2));
    expect(await host.frame()).toEqual({ type: MuxType.Close, sessionId: flooderId, code: CloseCode.IdleTimeout });
    expect((await flooder.closed).code).toBe(CloseCode.IdleTimeout);
    expect(quiet.socket.readyState).toBe(WebSocket.OPEN);
    expect(uplinkOpen(host)).toBe(true);
  });

  test("a credit client sending past its window ends alone, long before the uplink's 4 MiB", async () => {
    const ip = testIp();
    const host = await startRawHost(relay.url, ip, { credit: true });
    const greedy = await answered(host, ip, 1, BOTH_CREDIT);
    const other = await answered(host, ip, 2, BOTH_CREDIT);
    // The host never credits: the window lets 512 KiB through, then nothing once a credit step is uncredited.
    const chunk = SESSION_WINDOW_BYTES / 8;
    for (const _ of times(8)) greedy.client.socket.send(new Uint8Array(chunk));
    expect(await dataFrames(host, 8)).toHaveLength(8);
    greedy.client.socket.send(Uint8Array.of(1));
    expect(await host.frame()).toEqual({ type: MuxType.Close, sessionId: greedy.id, code: CloseCode.IdleTimeout });
    expect((await greedy.client.closed).code).toBe(CloseCode.IdleTimeout);
    host.probe.socket.send(encodeData(other.id, Uint8Array.of(3)));
    expect(Array.from(await other.client.next())).toEqual([3]);
    expect(uplinkOpen(host)).toBe(true);
  });
});
