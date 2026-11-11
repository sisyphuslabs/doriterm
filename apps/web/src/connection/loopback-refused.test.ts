import { afterAll, afterEach, beforeAll, expect, jest, test } from "bun:test";
import { connect, LoopbackTokenError } from "./connect.ts";
import { fakeWebSockets } from "./fake-websocket.test-support.ts";
import { hostFailure, isFinal } from "./host-failure.ts";
import { LinkCloseError } from "./ws-link.ts";
import { type ConnectionSettings, DEFAULT_SETTINGS } from "./settings.ts";

// #2003 (DORITERM-04): a loopback link the host refuses for its token is final and says so, as a relay link the host no
// longer knows is (DeviceNotPairedError); a host that is not there is still tried again.

Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined } });
const { ConnectionStore } = await import("./store.ts");
Reflect.deleteProperty(globalThis, "localStorage");

afterEach(() => jest.useRealTimers());

/** A gateway that refuses `/v1/hc` as a wrong token is refused (401 before the upgrade) and, if `e2ee`, opens /v1/e2ee. */
function gateway(e2ee: boolean): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/hc") return new Response("missing or wrong doriface token", { status: 401 });
      if (e2ee && path === "/v1/e2ee" && server.upgrade(request, { data: undefined })) return undefined;
      return new Response("not found", { status: 404 });
    },
    websocket: { message: () => undefined },
  });
}

const servers: ReturnType<typeof Bun.serve>[] = [];
let refusing = "";
let refusingWithoutE2ee = "";
let nobody = "";

beforeAll(async () => {
  const withE2ee = gateway(true);
  const withoutE2ee = gateway(false);
  const gone = gateway(false);
  servers.push(withE2ee, withoutE2ee);
  refusing = `ws://127.0.0.1:${withE2ee.port}/v1/hc`;
  refusingWithoutE2ee = `ws://127.0.0.1:${withoutE2ee.port}/v1/hc`;
  nobody = `ws://127.0.0.1:${gone.port}/v1/hc`;
  await gone.stop(true);
});

afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop(true)));
});

const settings = (loopbackUrl: string): ConnectionSettings => ({
  ...DEFAULT_SETTINGS,
  mode: "loopback",
  loopbackUrl,
  token: "stale",
});

const failure = (loopbackUrl: string): Promise<Error> =>
  connect(settings(loopbackUrl)).then(
    () => new Error("connected"),
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );

test("a host that answers but refuses the token is a final failure that names the token", async () => {
  const error = await failure(refusing);
  expect(error).toBeInstanceOf(LoopbackTokenError);
  expect(isFinal(error)).toBe(true);
  expect(hostFailure(error)).toContain("token");
});

test("a host that is not there, or whose answer cannot be told from absence, is tried again", async () => {
  const errors = await Promise.all([nobody, refusingWithoutE2ee].map(failure));
  expect(errors.map((error) => ({ final: isFinal(error), token: error instanceof LoopbackTokenError }))).toEqual([
    { final: false, token: false },
    { final: false, token: false },
  ]);
});

/** The back-off the store shows after a refused token: null when it stops trying. */
async function retryAfterRefusal(withStarter: boolean): Promise<number | null> {
  const store = new ConnectionStore(settings(refusing), () => Promise.reject(new LoopbackTokenError()));
  if (withStarter)
    store.restartsLocalHost({
      start: () => Promise.resolve({ url: refusing, token: "current" }),
      failure: () => ({ code: "unknown", message: "", details: "" }),
    });
  const reached = new Promise<void>((resolve) => {
    const off = store.subscribe(() => {
      if (store.state.phase !== "failed") return;
      off();
      resolve();
    });
  });
  store.start();
  await reached;
  const retry = store.state.phase === "failed" ? store.state.retryInMs : null;
  store.stop();
  return retry;
}

test("the store stops retrying a refused token, unless the desktop app's host can be asked for the current one", async () => {
  jest.useFakeTimers();
  expect(await retryAfterRefusal(false)).toBeNull();
  expect(await retryAfterRefusal(true)).not.toBeNull();
});

test("a dial closed before opening with a code of its own keeps that code, and nothing probes the host", async () => {
  const sockets = fakeWebSockets();
  try {
    const failed = failure("ws://127.0.0.1:9/v1/hc");
    await Promise.resolve();
    sockets.created[0]?.close(4404, "host not connected");
    const error = await failed;
    expect({ code: error instanceof LinkCloseError ? error.code : null, sockets: sockets.created.length }).toEqual({
      code: 4404,
      sockets: 1,
    });
  } finally {
    sockets.restore();
  }
});
