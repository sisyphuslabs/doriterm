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

afterEach(() => jest.useRealTimers());

function standIn(): HcConnection {
  const quiet = {
    hello: { core: { id: "c0re", name: "" } },
    onClose: () => () => undefined,
    close: () => undefined,
  };
  return quiet as unknown as HcConnection;
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

/** Advances the clock past a deadline in one step, flushing the microtasks the abandonment needs. */
async function pass(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await Promise.resolve();
  await Promise.resolve();
}

test("an attempt that never settles is abandoned at its deadline and retried", async () => {
  jest.useFakeTimers();
  let attempts = 0;
  const store = new ConnectionStore(RELAY, (): Promise<OpenConnection> => {
    attempts += 1;
    return new Promise(() => undefined);
  });
  store.start();
  await Promise.resolve();
  expect(store.state.phase).toBe("connecting");

  await pass(9_999);
  expect(store.state.phase).toBe("connecting");

  await pass(1);
  expect(store.state).toMatchObject({ phase: "failed" });
  if (store.state.phase === "failed") expect(store.state.error.name).toBe("AttemptTimeoutError");
  expect(attempts).toBe(1);
  store.stop();
});

test("the deadline doubles after each attempt that timed out, and stops at 30 s", async () => {
  jest.useFakeTimers();
  const store = new ConnectionStore(RELAY, () => new Promise<OpenConnection>(() => undefined));
  store.start();
  await Promise.resolve();

  // First attempt: 10 s.
  await pass(10_000);
  expect(store.state.phase).toBe("failed");
  // Its retry is armed for 1 s; let it start, then the next deadline must be 20 s, not 10.
  await pass(1_000);
  await pass(19_999);
  expect(store.state.phase).toBe("connecting");
  await pass(1);
  expect(store.state.phase).toBe("failed");

  // Its retry is armed for 2 s; the deadline is now capped at 30 s.
  await pass(2_000);
  await pass(29_999);
  expect(store.state.phase).toBe("connecting");
  await pass(1);
  expect(store.state.phase).toBe("failed");
  store.stop();
});

test("a wake gives the next attempt the base deadline again", async () => {
  jest.useFakeTimers();
  const store = new ConnectionStore(RELAY, () => new Promise<OpenConnection>(() => undefined));
  resumeOnWake(store);
  store.start();
  await Promise.resolve();

  await pass(10_000);
  expect(store.state.phase).toBe("failed");
  await pass(1_000);
  expect(store.state.phase).toBe("connecting");

  // The wake abandons the 20 s attempt and starts one with the base deadline: it must still be running at 10 s + 1 ms.
  dispatchEvent(new Event("pageshow"));
  await Promise.resolve();
  await Promise.resolve();
  await pass(10_001);
  expect(store.state.phase).toBe("failed");
  store.stop();
});

test("a session that opens resets the deadline for the next one", async () => {
  jest.useFakeTimers();
  const connection = standIn();
  let attempts = 0;
  const store = new ConnectionStore(RELAY, (): Promise<OpenConnection> => {
    attempts += 1;
    return attempts === 1 ? new Promise(() => undefined) : Promise.resolve({ connection, path: "relay" as const });
  });
  store.start();
  await Promise.resolve();
  await pass(10_000);
  expect(store.state.phase).toBe("failed");

  const open = settled(store, "open");
  await pass(1_000);
  await open;
  expect(attempts).toBe(2);
  store.stop();
});
