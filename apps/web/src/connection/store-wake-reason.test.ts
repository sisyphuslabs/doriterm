import { afterEach, expect, jest, test } from "bun:test";
import { type HcConnection, HcTimeoutError } from "@doriface/client";
import type { OpenConnection } from "./connect.ts";
import { type ConnectionSettings, DEFAULT_RELAY_URL, DEFAULT_SETTINGS } from "./settings.ts";
import type { ConnectionState } from "./store.ts";
import { WakeProbeUnansweredError } from "./wake.ts";

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

interface Core {
  readonly connection: HcConnection;
  readonly calls: string[];
  readonly closed: () => boolean;
  /** The wire reports a close the store never heard, as one that had already gone silent does. */
  readonly wireCloses: () => void;
}

/**
 * An open connection whose calls end as the real client ends them: with HcTimeoutError once their deadline passes.
 * `deafClose` is a wire that had already closed under the store, so the store's own `close()` reports nothing.
 */
function core({ deafClose = false }: { readonly deafClose?: boolean } = {}): Core {
  const calls: string[] = [];
  const listeners: ((error?: Error) => void)[] = [];
  let closed = false;
  const notify = (error?: Error): void => {
    for (const listener of listeners) listener(error);
  };
  const connection = {
    hello: { core: { id: "c0re", name: "" } },
    onClose: (listener: (error?: Error) => void) => (listeners.push(listener), () => undefined),
    close: () => {
      if (closed) return;
      closed = true;
      if (!deafClose) notify(undefined);
    },
    call: (method: string, _params: unknown, options: { readonly timeoutMs?: number } = {}) => {
      calls.push(method);
      return new Promise((_resolve, reject) => {
        if (options.timeoutMs !== undefined) {
          setTimeout(() => reject(new HcTimeoutError(method, options.timeoutMs ?? 0)), options.timeoutMs);
        }
      });
    },
  };
  return {
    connection: connection as unknown as HcConnection,
    calls,
    closed: () => closed,
    wireCloses: () => {
      closed = true;
      notify(undefined);
    },
  };
}

function settled(store: { subscribe: (fn: () => void) => () => void; state: ConnectionState }, phase: string) {
  return new Promise<void>((resolve) => {
    const read = (): void => {
      if (store.state.phase !== phase) return;
      off();
      resolve();
    };
    const off = store.subscribe(read);
    read();
  });
}

/** Lets the store's promise chains run: the probe's call, its handler and the drop it reports. */
async function flush(turns = 5): Promise<void> {
  if (turns === 0) return;
  await Promise.resolve();
  await flush(turns - 1);
}

// The close handler's other guard, `#closedFor?.connection === connection`, cannot stand alone in today's store: a
// different connection can only open after stop() cleared the reason, or after the close handler that clears it first.
// Here stop() is the only thing between a probe's reason and a close that names the same connection again.
test("stop() clears a probe's reason before the same connection can be opened again (#1127)", async () => {
  jest.useFakeTimers();
  // The wire had already closed under the store, so the probe's drop reaches no close handler and its reason waits.
  const only = core({ deafClose: true });
  let attempts = 0;
  const store = new ConnectionStore(RELAY, (): Promise<OpenConnection> => {
    attempts += 1;
    return Promise.resolve({ connection: only.connection, path: "relay" as const });
  });
  const open = settled(store, "open");
  store.start();
  await open;

  store.retryNow();
  await flush();
  jest.advanceTimersByTime(10_000);
  await flush();
  expect(only.closed()).toBe(true);

  // stop() is the only guard here: the store runs on that same connection again, so the closing connection's own
  // identity would take the stale reason if stop() had left it in place.
  store.stop();
  store.start();
  await flush();
  expect(attempts).toBe(2);
  expect(store.state.phase).toBe("open");

  const failed = settled(store, "failed");
  only.wireCloses();
  await failed;
  const error = store.state.phase === "failed" ? store.state.error : undefined;
  expect(error).toBeDefined();
  expect(error).not.toBeInstanceOf(WakeProbeUnansweredError);
  expect(error?.message).toBe("the host closed the connection");
  store.stop();
});
