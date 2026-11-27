import { afterEach, describe, expect, jest, test } from "bun:test";
import type { OpenConnection } from "./connect.ts";
import { DialBudget, RELAY_UPGRADES_PER_MINUTE } from "./relay-dial-budget.ts";
import { type ConnectionSettings, DEFAULT_RELAY_URL, DEFAULT_SETTINGS } from "./settings.ts";

// store.ts builds the app's store from localStorage as it loads; bun has none, so an empty one stands in for that load only.
Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined } });
const { ConnectionStore } = await import("./store.ts");
Reflect.deleteProperty(globalThis, "localStorage");

afterEach(() => jest.useRealTimers());

const member = (hostId: string): ConnectionSettings => ({
  ...DEFAULT_SETTINGS,
  mode: "relay",
  relayUrl: DEFAULT_RELAY_URL,
  hostId,
  hostKey: `k${hostId}`,
});

/** Lets the store's promise chains run under fake timers. */
async function turns(count = 10): Promise<void> {
  if (count === 0) return;
  await Promise.resolve();
  await turns(count - 1);
}

/** A minute less a step, a quarter second at a time: at 60 s the first upgrades leave the window and may go again. */
async function justUnderAMinute(advance: (ms: number) => void): Promise<void> {
  for (let step = 0; step < 239; step += 1) {
    advance(250);
    // oxlint-disable-next-line no-await-in-loop -- each retry's dial runs before the next one is due
    await turns();
  }
}

describe("the page's relay upgrade budget (#2933 review)", () => {
  test("a dial waits until its sockets fit in the last minute, and a cancelled one gives up at once", async () => {
    let now = 0;
    const budget = new DialBudget(5, () => now);
    await budget.acquire(3);
    expect(budget.waitMs(2)).toBe(0);
    await budget.acquire(2);
    now = 10_000;
    // Full: the dial fits once the 3 spent at 0 s have left the minute.
    expect(budget.waitMs(1)).toBe(50_000);
    const cancelled = new AbortController();
    const waiting = budget.acquire(1, cancelled.signal).then(
      () => "dialed",
      () => "cancelled",
    );
    cancelled.abort(new Error("woke"));
    expect(await waiting).toBe("cancelled");
    now = 60_000;
    expect(budget.waitMs(3)).toBe(0);
  });

  test("three offline machines share it: their fresh-connect dials stay within it, and each still dials", async () => {
    jest.useFakeTimers();
    let now = 0;
    const budget = new DialBudget(RELAY_UPGRADES_PER_MINUTE, () => now);
    const spent = { upgrades: 0 };
    const dialedBy = new Map<string, number>();
    // Each dial costs best-of-3 sockets, as a fresh connect to the release relay does, and the machine is offline.
    const open = async (settings: ConnectionSettings, signal?: AbortSignal): Promise<OpenConnection> => {
      await budget.acquire(3, signal);
      spent.upgrades += 3;
      dialedBy.set(settings.hostId, (dialedBy.get(settings.hostId) ?? 0) + 1);
      throw new Error("the host is offline (4404)");
    };
    const stores = ["a", "b", "c"].map((id) => new ConnectionStore(member(id), open, () => undefined));
    try {
      for (const store of stores) store.start();
      await justUnderAMinute((ms) => {
        now += ms;
        jest.advanceTimersByTime(ms);
      });
      expect(spent.upgrades).toBeLessThanOrEqual(RELAY_UPGRADES_PER_MINUTE);
      expect([...dialedBy.keys()].toSorted()).toEqual(["a", "b", "c"]);
    } finally {
      for (const store of stores) store.stop();
    }
  });

  test("one offline machine never waits on it: its ladder alone spends less than the minute's budget", async () => {
    jest.useFakeTimers();
    let now = 0;
    const budget = new DialBudget(RELAY_UPGRADES_PER_MINUTE, () => now);
    let upgrades = 0;
    let waited = false;
    const open = async (_settings: ConnectionSettings, signal?: AbortSignal): Promise<OpenConnection> => {
      if (budget.waitMs(3) > 0) waited = true;
      await budget.acquire(3, signal);
      upgrades += 3;
      throw new Error("the host is offline (4404)");
    };
    const store = new ConnectionStore(member("a"), open, () => undefined);
    try {
      store.start();
      await justUnderAMinute((ms) => {
        now += ms;
        jest.advanceTimersByTime(ms);
      });
      expect(waited).toBe(false);
      expect(upgrades).toBeLessThanOrEqual(RELAY_UPGRADES_PER_MINUTE);
      expect(upgrades).toBeGreaterThan(0);
    } finally {
      store.stop();
    }
  });
});
