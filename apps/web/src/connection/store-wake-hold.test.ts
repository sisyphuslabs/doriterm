import { afterEach, expect, jest, test } from "bun:test";
import { type HcConnection, HcTimeoutError } from "@doriface/client";
import type { OpenConnection } from "./connect.ts";
import { type ConnectionSettings, DEFAULT_RELAY_URL, DEFAULT_SETTINGS } from "./settings.ts";

// store.ts builds the app's store from localStorage as it loads; bun has none, so an empty one stands in for that load.
Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined } });
const { ConnectionStore } = await import("./store.ts");
Reflect.deleteProperty(globalThis, "localStorage");

const RELAY: ConnectionSettings = {
  ...DEFAULT_SETTINGS,
  mode: "relay",
  relayUrl: DEFAULT_RELAY_URL,
  hostId: "h0st",
  hostKey: "k3y",
};

afterEach(() => jest.useRealTimers());

/**
 * An open connection whose calls the spec answers one at a time; an unanswered call ends as the real client ends it,
 * with HcTimeoutError at its deadline. `deadlines` is every call's timeoutMs, in order.
 */
function core() {
  const deadlines: (number | undefined)[] = [];
  const answers: (() => void)[] = [];
  const listeners: ((error?: Error) => void)[] = [];
  let closed = false;
  const connection = {
    hello: { core: { id: "c0re", name: "" } },
    get closed() {
      return closed;
    },
    onClose: (listener: (error?: Error) => void) => (listeners.push(listener), () => undefined),
    close: () => {
      if (closed) return;
      closed = true;
      for (const listener of listeners) listener(undefined);
    },
    call: (method: string, _params: unknown, options: { readonly timeoutMs?: number } = {}) => {
      deadlines.push(options.timeoutMs);
      return new Promise((resolve, reject) => {
        answers.push(() => resolve([]));
        const after = options.timeoutMs ?? 0;
        setTimeout(() => reject(new HcTimeoutError(method, after)), after);
      });
    },
  };
  return {
    connection: connection as unknown as HcConnection,
    deadlines,
    answer: () => answers.shift()?.(),
    closed: () => closed,
  };
}

async function turns(count = 5): Promise<void> {
  if (count === 0) return;
  await Promise.resolve();
  await turns(count - 1);
}

/** A store open on `live`, its round trip read through the seam as `srtt`. */
async function openOn(live: ReturnType<typeof core>, srtt: number | undefined) {
  const opened = (): Promise<OpenConnection> =>
    Promise.resolve({ connection: live.connection, path: "relay" as const });
  const store = new ConnectionStore(RELAY, opened, undefined, { srttOf: () => srtt });
  store.start();
  await turns();
  expect(store.state.phase).toBe("open");
  return store;
}

/** The deadline a wake's check gets on a link whose smoothed round trip is `srtt`. */
async function deadlineFor(srtt: number | undefined): Promise<(number | undefined)[]> {
  const live = core();
  const store = await openOn(live, srtt);
  store.retryNow();
  await turns();
  live.answer();
  await turns();
  store.stop();
  return live.deadlines;
}

test("a wake's check waits four smoothed round trips and 500 ms, from 1.5 s to 10 s, and 10 s with no sample (#1370)", async () => {
  jest.useFakeTimers();
  const deadlines = (await Promise.all([250, 1_000, 5_000, undefined].map(deadlineFor))).flat();
  expect(deadlines).toEqual([1_500, 4_500, 10_000, 10_000]);
});

test("over a 250 ms relay a link that does not answer the wake is dropped at 1.5 s, not 10 s (#1370)", async () => {
  jest.useFakeTimers();
  const live = core();
  const store = await openOn(live, 250);
  store.retryNow();
  await turns();
  jest.advanceTimersByTime(1_499);
  await turns();
  expect(live.closed()).toBe(false);
  jest.advanceTimersByTime(1);
  await turns();
  expect(live.closed()).toBe(true);
  expect(store.state.phase).toBe("failed");
  store.stop();
});

test("the open state says the link is being proved from the wake until the core answers (#1370)", async () => {
  jest.useFakeTimers();
  const live = core();
  const store = await openOn(live, 250);
  const proving = () => (store.state.phase === "open" ? store.state.proving : "not open");
  expect(proving()).not.toBe(true);

  store.retryNow();
  expect(proving()).toBe(true);
  live.answer();
  await turns();
  expect(proving()).toBe(false);
  expect(live.closed()).toBe(false);
  store.stop();
});

test("a check that goes unanswered ends the proving with the link: the state is no longer open (#1370)", async () => {
  jest.useFakeTimers();
  const live = core();
  const store = await openOn(live, 250);
  store.retryNow();
  expect(store.state.phase === "open" && store.state.proving).toBe(true);
  jest.advanceTimersByTime(1_500);
  await turns();
  expect(store.state.phase).not.toBe("open");
  store.stop();
});
