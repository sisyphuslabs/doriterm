import { afterEach, describe, expect, test } from "bun:test";
import { type ClientConnectOptions, connectRelayClient } from "./connector.ts";
import { RelayCloseError } from "./link.ts";
import type { WebSocketLink } from "./websocket-link.ts";

interface Accepted {
  readonly index: number;
  readonly binary: Uint8Array[];
  readonly closed: Promise<number>;
}

interface FakeRelay {
  readonly url: string;
  readonly accepted: Accepted[];
  /** Resolves once `count` pings arrived, so that many sockets are open and being timed. */
  readonly pinged: (count: number) => Promise<void>;
  /** A CreateSocket that sends a named relay's sockets here instead, as DNS would send them to an edge. */
  readonly redirect: (url: string) => WebSocket;
  readonly stop: () => Promise<void>;
}

/** A relay stand-in: `answersPing` decides, by the order a socket was accepted in, whether the Room answers its ping. */
function fakeRelay(behaviour: {
  readonly answersPing?: (index: number) => boolean;
  readonly closeWith?: number;
}): FakeRelay {
  const accepted: Accepted[] = [];
  let pings = 0;
  const waiters: { readonly count: number; readonly resolve: () => void }[] = [];
  const closers = new Map<number, (code: number) => void>();
  const server = Bun.serve<{ index: number }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, srv) =>
      srv.upgrade(request, { data: { index: accepted.length } }) ? undefined : new Response("upgrade", { status: 426 }),
    websocket: {
      open: (ws) => {
        const closed = Promise.withResolvers<number>();
        closers.set(ws.data.index, closed.resolve);
        accepted.push({ index: ws.data.index, binary: [], closed: closed.promise });
        if (behaviour.closeWith !== undefined) ws.close(behaviour.closeWith, "host offline");
      },
      message: (ws, message) => {
        if (message === "ping") {
          pings += 1;
          for (const waiter of waiters.filter((w) => pings >= w.count)) waiter.resolve();
          if (behaviour.answersPing?.(ws.data.index) === true) ws.send("pong");
        }
        if (typeof message !== "string") accepted[ws.data.index]?.binary.push(new Uint8Array(message));
      },
      close: (ws, code) => closers.get(ws.data.index)?.(code),
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    accepted,
    pinged: (count) =>
      pings >= count
        ? Promise.resolve()
        : new Promise((resolve) => {
            waiters.push({ count, resolve });
          }),
    redirect: (url) => new WebSocket(url.replace(/^wss:\/\/relay\.example(:\d+)?/, `ws://127.0.0.1:${server.port}`)),
    stop: () => server.stop(true),
  };
}

const hostId = "a".repeat(26);
const relays: FakeRelay[] = [];
afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.stop()));
});

function started(relay: FakeRelay): FakeRelay {
  relays.push(relay);
  return relay;
}

/** The close a link ends with, as its RelayCloseError code (1000 for a normal close). */
function closeCodeOf(link: WebSocketLink): Promise<number> {
  return new Promise((resolve) =>
    link.onClose((error) => resolve(error instanceof RelayCloseError ? error.code : 1000)),
  );
}

describe("best-of-N relay dial", () => {
  test("a session to a named relay opens three sockets, keeps the one the Room answered, and closes the others before any data", async () => {
    const relay = started(fakeRelay({ answersPing: (index) => index === 1 }));
    const link = await connectRelayClient({ relayUrl: "https://relay.example", hostId, createSocket: relay.redirect });
    expect(relay.accepted.length).toBe(3);
    link.send(new Uint8Array([1, 3, 5, 1]));
    expect(await Promise.all([relay.accepted[0]?.closed, relay.accepted[2]?.closed])).toEqual([1000, 1000]);
    link.send(new Uint8Array([9]));
    await link.drained();
    const kept = closeCodeOf(link);
    link.close();
    await kept;
    expect(await relay.accepted[1]?.closed).toBe(1000);
    expect(relay.accepted.map(({ binary }) => binary.length)).toEqual([0, 2, 0]);
    expect(relay.accepted[1]?.binary[0]).toEqual(new Uint8Array([1, 3, 5, 1]));
  });

  test("the other sockets to a relay on the default HTTPS port go to its edge's other HTTPS ports", async () => {
    // A browser holds back a WebSocket handshake while another to the same address and port is still connecting, so
    // three sockets to one port open one after another and the later ones miss the race (#1418).
    const relay = started(fakeRelay({ answersPing: () => true }));
    const dialed = async (relayUrl: string): Promise<string[]> => {
      const urls: string[] = [];
      const link = await connectRelayClient({
        relayUrl,
        hostId,
        createSocket: (url) => {
          urls.push(url);
          return relay.redirect(url);
        },
      });
      const closed = closeCodeOf(link);
      link.close();
      await closed;
      return urls.map((url) => new URL(url).port);
    };
    expect(await dialed("https://relay.example")).toEqual(["", "8443", "2053"]);
    expect(await dialed("wss://relay.example:443")).toEqual(["", "8443", "2053"]);
    expect(await dialed("https://relay.example:4443")).toEqual(["4443", "4443", "4443"]);
  });

  test("a refusal still reaches the caller as the kept link's close code", async () => {
    const relay = started(fakeRelay({ closeWith: 4404 }));
    const outcome = await connectRelayClient({
      relayUrl: "https://relay.example",
      hostId,
      createSocket: relay.redirect,
    }).then(closeCodeOf, (error: unknown) => (error instanceof RelayCloseError ? error.code : String(error)));
    expect(outcome).toBe(4404);
  });

  test("pairing sessions, proven dials and relays on loopback open one socket", async () => {
    const relay = started(fakeRelay({ answersPing: () => true }));
    const dial = async (options: Partial<ClientConnectOptions>): Promise<number> => {
      const before = relay.accepted.length;
      const link = await connectRelayClient({ relayUrl: "https://relay.example", hostId, ...options });
      const closed = closeCodeOf(link);
      link.close();
      await closed;
      return relay.accepted.length - before;
    };
    const proofs = { proof: () => "proof", refused: () => undefined };
    const named = { createSocket: relay.redirect };
    expect(await dial({ ...named, pairSlot: "7QK" })).toBe(1);
    expect(await dial({ ...named, proofs })).toBe(1);
    expect(await dial({ ...named, bestOf: 1 })).toBe(1);
    expect(await dial({ relayUrl: relay.url })).toBe(1);
    expect(await dial({ relayUrl: relay.url.replace("127.0.0.1", "localhost") })).toBe(1);
  });

  test("cancelling while the sockets are being timed rejects with the reason and closes all of them", async () => {
    const relay = started(fakeRelay({}));
    const cancelled = new AbortController();
    const dialing = connectRelayClient({
      relayUrl: "https://relay.example",
      hostId,
      createSocket: relay.redirect,
      signal: cancelled.signal,
    }).catch((error: unknown) => error);
    await relay.pinged(3);
    cancelled.abort(new Error("the person changed the settings"));
    expect(String(await dialing)).toBe("Error: the person changed the settings");
    expect(await Promise.all(relay.accepted.map(({ closed }) => closed))).toEqual([1000, 1000, 1000]);
  });
});
