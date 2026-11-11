import { afterEach, expect, jest, test } from "bun:test";
import { type FakeSocket, fakeWebSockets } from "./fake-websocket.test-support.ts";
import { openWebSocketLink } from "./ws-link.ts";

const URL = "ws://127.0.0.1:7767/v1/e2ee";
const PROTOCOLS = ["doriface.v1"];
const PING_MS = 30_000;

let sockets: ReturnType<typeof fakeWebSockets> | undefined;
afterEach(() => {
  jest.useRealTimers();
  sockets?.restore();
  sockets = undefined;
});

/** A link opened on a socket the test holds, so it can watch every send and close it as a browser would. */
async function opened(
  options: Parameters<typeof openWebSocketLink>[2] = {},
): Promise<{ readonly link: Awaited<ReturnType<typeof openWebSocketLink>>; readonly socket: FakeSocket }> {
  sockets = fakeWebSockets();
  const opening = openWebSocketLink(URL, PROTOCOLS, options);
  const socket = sockets.created[0];
  if (socket === undefined) throw new Error("the link opened no socket");
  socket.open();
  return { link: await opening, socket };
}

test("a closed link stops pinging and clears its interval (#1114)", async () => {
  jest.useFakeTimers();
  const { link, socket } = await opened({ pingIntervalMs: PING_MS });
  jest.advanceTimersByTime(PING_MS);
  expect(socket.sent).toEqual(["ping"]);

  link.close();
  expect(socket.closedWith).toBe(1000);
  jest.advanceTimersByTime(PING_MS * 4);
  // The socket is closed, so no ping can leave it; the interval behind them must be gone too.
  expect(socket.sent).toEqual(["ping"]);
  expect(jest.getTimerCount()).toBe(0);
});

test("an abort after the link opened stops pinging and clears its interval (#1114)", async () => {
  jest.useFakeTimers();
  const cancelled = new AbortController();
  const { socket } = await opened({ pingIntervalMs: PING_MS, signal: cancelled.signal });
  jest.advanceTimersByTime(PING_MS);
  expect(socket.sent).toEqual(["ping"]);

  cancelled.abort();
  expect(socket.closedWith).toBe(1005);
  jest.advanceTimersByTime(PING_MS * 4);
  expect(socket.sent).toEqual(["ping"]);
  expect(jest.getTimerCount()).toBe(0);
});
