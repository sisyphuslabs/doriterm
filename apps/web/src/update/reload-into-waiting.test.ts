import { describe, expect, test } from "bun:test";
import {
  MAX_LOADS,
  reloadIntoWaitingWorker,
  resumeUpdate,
  RETRY_MS,
  SWAP_MS,
  type UpdateDeps,
} from "./reload-into-waiting.ts";

interface Page {
  readonly deps: UpdateDeps;
  readonly sent: unknown[];
  readonly timers: { readonly ms: number; readonly run: () => void }[];
  reloads: number;
  changeController(): void;
}

interface World {
  waiting: { state: string } | null;
  active: boolean;
  controlled: boolean;
  readonly store: Map<string, string>;
}

const world = (waiting: string | null, over: Partial<World> = {}): World => ({
  waiting: waiting === null ? null : { state: waiting },
  active: true,
  controlled: true,
  store: new Map(),
  ...over,
});

/** One page load in `w`: the browser as the update code sees it. */
function page(w: World): Page {
  let onChange: (() => void) | undefined;
  const p: Page = {
    sent: [],
    timers: [],
    reloads: 0,
    changeController: () => onChange?.(),
    deps: {
      workers: {
        get controller() {
          return w.controlled ? {} : null;
        },
        getRegistration: () =>
          Promise.resolve({
            waiting:
              w.waiting === null ? null : { ...w.waiting, postMessage: (message: unknown) => p.sent.push(message) },
            active: w.active ? {} : null,
          }),
        addEventListener: (_type, listener) => {
          onChange = listener;
        },
      },
      reload: () => {
        p.reloads += 1;
      },
      storage: {
        getItem: (key) => w.store.get(key) ?? null,
        setItem: (key, value) => w.store.set(key, value),
        removeItem: (key) => w.store.delete(key),
      },
      after: (ms, run) => p.timers.push({ ms, run }),
    },
  };
  return p;
}

describe("Reload to update (#418)", () => {
  test("asks the waiting worker to take over and reloads on the controller change, once", async () => {
    const p = page(world("installed"));
    await reloadIntoWaitingWorker(p.deps);
    expect(p.sent).toEqual([{ type: "SKIP_WAITING" }]);
    expect(p.reloads).toBe(0);
    p.changeController();
    p.changeController();
    expect(p.reloads).toBe(1);
  });

  test("a worker still installed after SWAP_MS is reloaded into, and a reload that never loads is sent again", async () => {
    const p = page(world("installed"));
    await reloadIntoWaitingWorker(p.deps);
    expect(p.timers.map((timer) => timer.ms)).toEqual([SWAP_MS]);
    p.timers[0]?.run();
    expect(p.reloads).toBe(1);
    for (let retry = 1; retry <= 5; retry += 1) {
      expect(p.timers.at(-1)?.ms).toBe(RETRY_MS);
      p.timers.at(-1)?.run();
      expect(p.reloads).toBe(1 + retry);
    }
  });

  test("a worker that left installed (activating) is not reloaded into early", async () => {
    const p = page(world("activating"));
    await reloadIntoWaitingWorker(p.deps);
    // The swap wait is booked, so the 0 below is the worker still activating, not a page that never waited (#2354).
    expect(p.timers.map((timer) => timer.ms)).toEqual([SWAP_MS]);
    p.timers[0]?.run();
    expect(p.reloads).toBe(0);
  });

  test("the next page is done once it is controlled and no worker waits", async () => {
    const w = world("installed");
    await reloadIntoWaitingWorker(page(w).deps);
    // The first page left the Reload to update marked, so an empty store below is this page clearing it (#2354).
    expect(w.store.size).toBe(1);
    w.waiting = null;
    const next = page(w);
    await resumeUpdate(next.deps);
    expect(next.reloads).toBe(0);
    expect(next.timers).toEqual([]);
    expect(w.store.size).toBe(0);
  });

  test("a page that loaded uncontrolled while a worker is active carries on", async () => {
    const w = world("installed");
    await reloadIntoWaitingWorker(page(w).deps);
    w.waiting = null;
    w.controlled = false;
    const next = page(w);
    await resumeUpdate(next.deps);
    expect(next.reloads).toBe(1);
  });

  test(`it carries on for at most ${MAX_LOADS} loads, then leaves the update waiting`, async () => {
    const w = world("installed");
    await reloadIntoWaitingWorker(page(w).deps);
    const load = async (left: number, carried: number): Promise<number> => {
      if (left === 0) return carried;
      const next = page(w);
      await resumeUpdate(next.deps);
      for (const timer of next.timers) if (timer.ms === SWAP_MS) timer.run();
      return load(left - 1, carried + (next.reloads > 0 ? 1 : 0));
    };
    const carried = await load(5, 0);
    expect(carried).toBe(MAX_LOADS - 1);
    expect(w.store.size).toBe(0);
  });

  test("with no waiting worker it reloads at once", async () => {
    const p = page(world(null));
    await reloadIntoWaitingWorker(p.deps);
    expect(p.sent).toEqual([]);
    expect(p.reloads).toBe(1);
  });
});
