import { afterEach, expect, jest, test } from "bun:test";
import { DEFAULT_SETTINGS, type ConnectionSettings } from "./settings.ts";

// store.ts builds the app's store from localStorage as it loads; bun has none, so an empty one stands in for that load only.
Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined } });
const { ConnectionStore } = await import("./store.ts");
Reflect.deleteProperty(globalThis, "localStorage");

const SETTINGS: ConnectionSettings = { ...DEFAULT_SETTINGS, mode: "loopback", token: "t0k" };

afterEach(() => jest.useRealTimers());

/** A store whose host refuses every dial, and how many dials it has made. */
function refused() {
  let dials = 0;
  const store = new ConnectionStore(SETTINGS, () => {
    dials += 1;
    return Promise.reject(new Error("host unreachable (1011)"));
  });
  const failed = (): Promise<void> =>
    new Promise((resolve) => {
      const off = store.subscribe(() => {
        if (store.state.phase !== "failed") return;
        off();
        resolve();
      });
    });
  return { store, failed, dials: () => dials };
}

test("typing through a refused reconnect dials early but never moves the next attempt later (#2256, #2266)", async () => {
  jest.useFakeTimers();
  const { store, failed, dials } = refused();
  const first = failed();
  store.start();
  await first;
  expect(store.state).toMatchObject({ phase: "failed", retryInMs: 1_000 });
  const due = store.state.phase === "failed" ? store.state.retryAt : null;

  // A key typed 250 ms on (the pane's own cooldown) while the host still refuses.
  const typed = async (): Promise<void> => {
    jest.advanceTimersByTime(250);
    const again = failed();
    store.nudge();
    await again;
    expect(store.state).toMatchObject({ phase: "failed", retryAt: due });
  };
  await typed();
  await typed();
  await typed();
  expect(dials()).toBe(4);

  // The back-off's own attempt still comes when it was due, and its refusal climbs one step, as with no typing at all.
  const own = failed();
  jest.advanceTimersByTime(250);
  await own;
  expect(dials()).toBe(5);
  expect(store.state).toMatchObject({ phase: "failed", retryInMs: 2_000 });
  store.stop();
});

test("a nudge dials nothing while an attempt is already out", () => {
  const dials: string[] = [];
  const store = new ConnectionStore(SETTINGS, () => {
    dials.push("dial");
    return new Promise(() => {});
  });
  store.start();
  expect(store.state.phase).toBe("connecting");
  store.nudge();
  expect(dials).toEqual(["dial"]);
  store.stop();
});
