import { afterEach, expect, jest, test } from "bun:test";
import { HcCoreMismatchError } from "@doriface/client";
import type { OpenConnection } from "./connect.ts";
import { hostFailure } from "./host-failure.ts";
import { type ConnectionSettings, DEFAULT_RELAY_URL, DEFAULT_SETTINGS } from "./settings.ts";
import type { ConnectionState } from "./store.ts";

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

const MISMATCH = new HcCoreMismatchError({ kind: "core-too-old", version: "0.1.16", need: "0.1.17" });

afterEach(() => jest.useRealTimers());

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

test("a core this client cannot use fails for good: no retry is armed and nothing more is dialed", async () => {
  jest.useFakeTimers();
  let attempts = 0;
  const store = new ConnectionStore(RELAY, (): Promise<OpenConnection> => {
    attempts += 1;
    return Promise.reject(MISMATCH);
  });
  const failed = settled(store, "failed");
  store.start();
  await failed;

  expect(store.state).toEqual({ phase: "failed", error: MISMATCH, retryInMs: null, retryAt: null, stale: null });
  await Promise.resolve();
  jest.advanceTimersByTime(120_000);
  await Promise.resolve();
  expect(attempts).toBe(1);
  expect(store.state.phase).toBe("failed");
  store.stop();
});

test("the words the person reads come from the same error, so the row and the reason agree", () => {
  expect(hostFailure(MISMATCH)).toContain("doriface-host --install-hc");
});
