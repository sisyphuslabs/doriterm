import { afterEach, expect, jest, test } from "bun:test";
import type { HcConnection } from "@doriface/client";
import type { OpenConnection } from "./connect.ts";
import { type ConnectionSettings, DEFAULT_RELAY_URL, DEFAULT_SETTINGS } from "./settings.ts";
import type { ConnectionState } from "./store.ts";
import { resumeOnWake } from "./wake.ts";

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

const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

afterEach(() => {
  jest.useRealTimers();
  if (navigatorDescriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
  else Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
});

function standIn(): { readonly connection: HcConnection; readonly closes: ((error?: Error) => void)[] } {
  const closes: ((error?: Error) => void)[] = [];
  const connection = {
    hello: { core: { id: "c0re", name: "" } },
    onClose: (listener: (error?: Error) => void) => (closes.push(listener), () => undefined),
    close: () => undefined,
    // A live core: a wake with the link open asks it one call (#653), and it answers.
    call: () => Promise.resolve([]),
  };
  return { connection: connection as unknown as HcConnection, closes };
}

function settled(
  store: { subscribe: (fn: () => void) => () => void; state: ConnectionState },
  phase: string,
): Promise<void> {
  return new Promise((resolve) => {
    const read = (): void => {
      if (store.state.phase !== phase) return;
      off();
      resolve();
    };
    const off = store.subscribe(read);
    read();
  });
}

function page(store: { retryNow(): void }): {
  readonly target: EventTarget;
  readonly setVisible: (visible: boolean) => void;
} {
  const target = new EventTarget();
  let visibility = "visible";
  resumeOnWake(store, {
    on: (type, listener) => target.addEventListener(type, listener),
    visibility: {
      state: () => visibility,
      listen: (listener) => target.addEventListener("visibilitychange", listener),
    },
  });
  return { target, setVisible: (visible) => (visibility = visible ? "visible" : "hidden") };
}

test("a page that comes back runs a waiting reconnect at once, without waiting out its back-off", async () => {
  jest.useFakeTimers();
  const { connection } = standIn();
  let attempts = 0;
  const store = new ConnectionStore(RELAY, (): Promise<OpenConnection> => {
    attempts += 1;
    return attempts === 1
      ? Promise.reject(new Error("refused"))
      : Promise.resolve({ connection, path: "relay" as const });
  });
  resumeOnWake(store);
  const failed = settled(store, "failed");
  store.start();
  await failed;
  expect(store.state).toMatchObject({ phase: "failed", retryInMs: 1_000 });

  const open = settled(store, "open");
  dispatchEvent(new Event("pageshow"));
  await open;
  expect(attempts).toBe(2);
  store.stop();
});

test("a tab that becomes visible runs the waiting reconnect, and one that goes hidden does not", async () => {
  jest.useFakeTimers();
  const { connection } = standIn();
  let attempts = 0;
  const store = new ConnectionStore(RELAY, (): Promise<OpenConnection> => {
    attempts += 1;
    return attempts === 1
      ? Promise.reject(new Error("refused"))
      : Promise.resolve({ connection, path: "relay" as const });
  });
  const { target, setVisible } = page(store);
  const failed = settled(store, "failed");
  store.start();
  await failed;

  setVisible(false);
  target.dispatchEvent(new Event("visibilitychange"));
  await Promise.resolve();
  expect(attempts).toBe(1);

  const open = settled(store, "open");
  setVisible(true);
  target.dispatchEvent(new Event("visibilitychange"));
  await open;
  expect(attempts).toBe(2);
  store.stop();
});

test("a wake replaces the attempt already in flight instead of waiting for it", async () => {
  jest.useFakeTimers();
  const { connection } = standIn();
  const signals: (AbortSignal | undefined)[] = [];
  let attempts = 0;
  const store = new ConnectionStore(RELAY, (_settings, signal): Promise<OpenConnection> => {
    attempts += 1;
    signals.push(signal);
    if (attempts === 1) return Promise.reject(new Error("refused"));
    if (attempts === 2) return new Promise(() => undefined);
    return Promise.resolve({ connection, path: "relay" as const });
  });
  const failed = settled(store, "failed");
  store.start();
  await failed;

  jest.advanceTimersByTime(1_000);
  await Promise.resolve();
  expect(store.state.phase).toBe("connecting");

  resumeOnWake(store);
  dispatchEvent(new Event("pageshow"));
  await Promise.resolve();
  await Promise.resolve();
  expect(attempts).toBe(3);
  expect(signals[1]?.aborted).toBe(true);
  store.stop();
});

test("a link that opens and drops keeps backing off instead of starting over", async () => {
  jest.useFakeTimers();
  const { connection, closes } = standIn();
  const store = new ConnectionStore(RELAY, (): Promise<OpenConnection> =>
    Promise.resolve({ connection, path: "relay" as const }),
  );
  const delays: number[] = [];
  store.subscribe(() => {
    const state = store.state;
    if (state.phase === "failed" && state.retryInMs !== null) delays.push(state.retryInMs);
  });

  const cycle = async (): Promise<void> => {
    const failed = settled(store, "failed");
    closes.at(-1)?.(new Error("dropped"));
    await failed;
    jest.advanceTimersByTime(delays.at(-1) ?? 0);
    await Promise.resolve();
    await Promise.resolve();
    const open = settled(store, "open");
    await open;
  };

  const first = settled(store, "open");
  store.start();
  await first;
  await cycle();
  await cycle();
  await cycle();
  store.stop();
  expect(delays).toEqual([1_000, 2_000, 5_000]);
});

test("a link that stayed up past the stability floor starts over when it drops", async () => {
  jest.useFakeTimers();
  const { connection, closes } = standIn();
  const store = new ConnectionStore(RELAY, (): Promise<OpenConnection> =>
    Promise.resolve({ connection, path: "relay" as const }),
  );
  const delays: number[] = [];
  store.subscribe(() => {
    const state = store.state;
    if (state.phase === "failed" && state.retryInMs !== null) delays.push(state.retryInMs);
  });

  const open = settled(store, "open");
  store.start();
  await open;
  jest.advanceTimersByTime(10_000);
  const failed = settled(store, "failed");
  closes.at(-1)?.(new Error("dropped"));
  await failed;
  store.stop();
  expect(delays).toEqual([500]);
});

test("with no network the store dials nothing, and the network coming back dials at once", async () => {
  jest.useFakeTimers();
  Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true, writable: true });
  const { connection } = standIn();
  let attempts = 0;
  const store = new ConnectionStore(RELAY, (): Promise<OpenConnection> => {
    attempts += 1;
    return Promise.resolve({ connection, path: "relay" as const });
  });
  store.start();
  await Promise.resolve();
  await Promise.resolve();
  expect(store.state.phase).toBe("failed");
  expect(attempts).toBe(0);

  resumeOnWake(store);
  Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true, writable: true });
  dispatchEvent(new Event("online"));
  await Promise.resolve();
  await Promise.resolve();
  expect(attempts).toBe(1);
  store.stop();
});
