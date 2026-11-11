import { describe, expect, test } from "bun:test";
import { HcRpcError, type Terminal } from "@doriface/protocol";
import { PENDING_END_MAX_AGE_MS, pendingEnds, resumeOf, routedPendingEnds } from "./pending-ends.ts";
import { addressOf, identityOf } from "./terminal-identity.ts";
import { recordedEnd, resumeEnds } from "./resume-ends.ts";
import type { SessionCalls } from "./session-actions.ts";

/** A Storage held in memory, as localStorage holds it. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

const notFound = (): HcRpcError =>
  new HcRpcError({ code: -32000, message: "no terminal", data: { kind: "not_found" } });

/** Session calls that record what they are asked; terminal.kill answers with a finished terminal. */
function recorder() {
  const asked: string[] = [];
  const calls: SessionCalls = {
    label: ({ terminal }) => (asked.push(`label ${terminal}`), Promise.resolve({})),
    kill: ({ terminal }) => (asked.push(`kill ${terminal}`), Promise.resolve({ state: "finished" })),
    rm: ({ terminal }) => (asked.push(`rm ${terminal}`), Promise.resolve({})),
  };
  return { asked, calls };
}

const facts = (state: Terminal["state"], pid: number | null, created_ms = 500) => ({ state, pid, created_ms });

describe("pending Ends", () => {
  test("are kept per core, one per address, and the stale ones are not offered", () => {
    const storage = memoryStorage();
    const ends = pendingEnds("core-a", storage);
    ends.add({ address: "t1", pid: 10, created: 1, at: 1_000 });
    ends.add({ address: "t2", pid: 20, created: 2, at: 2_000 });
    ends.add({ address: "t1", pid: 11, created: 3, at: 3_000 });
    expect(pendingEnds("core-a", storage).list(3_000)).toEqual([
      { address: "t2", pid: 20, created: 2, at: 2_000 },
      { address: "t1", pid: 11, created: 3, at: 3_000 },
    ]);
    expect(pendingEnds("core-b", storage).list(3_000)).toEqual([]);
    expect(ends.list(2_000 + PENDING_END_MAX_AGE_MS + 1)).toEqual([{ address: "t1", pid: 11, created: 3, at: 3_000 }]);
    ends.remove("t2");
    ends.remove("t1");
    expect(storage.length).toBe(0);
  });

  test("a store that cannot be written keeps nothing and does not throw", () => {
    const refusing: Storage = {
      ...memoryStorage(),
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const ends = pendingEnds("core-a", refusing);
    ends.add({ address: "t1", pid: 1, created: 1, at: 0 });
    expect(ends.list(0)).toEqual([]);
  });

  test("resume ends or removes only the very terminal it was asked about, and drops everything else", () => {
    const end = { address: "build/t1", pid: 42, created: 500, at: 0 };
    expect(resumeOf(end, facts("live", 42))).toBe("end");
    expect(resumeOf(end, facts("finished", 42))).toBe("remove");
    // Another program at the address: a restart, or a machine whose name now names another machine.
    expect(resumeOf(end, facts("live", 43))).toBe("drop");
    expect(resumeOf(end, facts("finished", 43))).toBe("drop");
    expect(resumeOf(end, facts("live", 42, 900))).toBe("drop");
    expect(resumeOf(end, facts("finished", 42, 900))).toBe("drop");
    // A record that cannot say which program it was about never acts.
    expect(resumeOf({ ...end, pid: null }, facts("live", 7))).toBe("drop");
    expect(resumeOf({ ...end, pid: null }, facts("finished", 7))).toBe("drop");
    expect(resumeOf(end, null)).toBe("drop");
  });
});

describe("resuming pending Ends", () => {
  test("ends, removes or drops each, and forgets every one it saw through", async () => {
    const storage = memoryStorage();
    const ends = pendingEnds("core", storage);
    for (const [address, at] of [
      ["t1", 1],
      ["t2", 2],
      ["t3", 3],
      ["t4", 4],
    ] as const) {
      ends.add({ address, pid: 9, created: 500, at: Date.now() - 1_000 + at });
    }
    const terminals: Record<string, Pick<Terminal, "state" | "pid" | "created_ms">> = {
      t1: { state: "live", pid: 9, created_ms: 500 },
      t2: { state: "finished", pid: 9, created_ms: 500 },
      t3: { state: "live", pid: 99, created_ms: 500 },
    };
    const { asked, calls } = recorder();
    const get = (address: string) => {
      const terminal = terminals[address];
      return terminal === undefined ? Promise.reject(notFound()) : Promise.resolve(terminal);
    };
    await resumeEnds(ends, get, calls);
    expect(asked).toEqual(["label t1", "kill t1", "rm t1", "rm t2"]);
    expect(ends.list()).toEqual([]);
  });

  test("an End that fails again stays pending for the next connection", async () => {
    const ends = pendingEnds("core", memoryStorage());
    ends.add({ address: "t1", pid: 9, created: 500, at: Date.now() });
    const calls: SessionCalls = {
      label: () => Promise.resolve({}),
      kill: () => Promise.reject(new Error("connection is closed")),
      rm: () => Promise.resolve({}),
    };
    const errors: unknown[] = [];
    const log = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      await resumeEnds(ends, () => Promise.resolve({ state: "live", pid: 9, created_ms: 500 }), calls);
    } finally {
      console.error = log;
    }
    expect(ends.list().map((end) => end.address)).toEqual(["t1"]);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("stops once the connection it runs on is gone", async () => {
    const ends = pendingEnds("core", memoryStorage());
    ends.add({ address: "t1", pid: 9, created: 500, at: Date.now() });
    const { asked, calls } = recorder();
    await resumeEnds(
      ends,
      () => Promise.resolve({ state: "live", pid: 9, created_ms: 500 }),
      calls,
      () => false,
    );
    expect(asked).toEqual([]);
    expect(ends.list().length).toBe(1);
  });
  test("an End asked through the record clears it whether it succeeds or fails", async () => {
    const ends = pendingEnds("core", memoryStorage());
    const end = { address: "t1", pid: 9, created: 500, at: Date.now() };
    const { calls } = recorder();
    await recordedEnd(ends, end, calls);
    expect(ends.list()).toEqual([]);
    const refused: SessionCalls = { ...calls, kill: () => Promise.reject(new Error("connection is closed")) };
    const failed = recordedEnd(ends, end, refused);
    expect(ends.list().map((entry) => entry.address)).toEqual(["t1"]);
    await expect(failed).rejects.toThrow("connection is closed");
    // Left after "The session did not end", the session is the person's to keep: no later page may end it.
    expect(ends.list()).toEqual([]);
  });
});

describe("one terminal, one identity, however it is reached (#2288)", () => {
  // Young enough to resume: list() reads its age against the clock.
  const NOW = Date.now();
  // Core A lists machine B as "build-box"; reached as its own connection, B is the route's core.
  const throughA = { core: "core-a", machines: [{ name: "build-box", id: "core-b" }] };
  const directB = { core: "core-b", machines: [] };

  test("the same terminal resolves to one identity both ways, and back to each route's address", () => {
    const viaA = identityOf("build-box/t7", throughA);
    expect(viaA).toEqual({ core: "core-b", terminal: "t7" });
    expect(identityOf("t7", directB)).toEqual(viaA);
    expect(viaA === undefined ? undefined : addressOf(viaA, directB)).toBe("t7");
    expect(addressOf({ core: "core-b", terminal: "t7" }, throughA)).toBe("build-box/t7");
    expect(identityOf("t3", throughA)).toEqual({ core: "core-a", terminal: "t3" });
    expect(identityOf("other/t1", throughA)).toBeUndefined();
  });

  test("an End asked through A resumes when B is reached directly", async () => {
    const storage = memoryStorage();
    routedPendingEnds(throughA, storage).add({ address: "build-box/t7", pid: 70, created: 500, at: NOW });
    const { asked, calls } = recorder();
    await resumeEnds(routedPendingEnds(directB, storage), () => Promise.resolve(facts("live", 70)), calls);
    expect(asked).toEqual(["label t7", "kill t7", "rm t7"]);
    expect(routedPendingEnds(throughA, storage).list()).toEqual([]);
  });

  test("an End asked directly on B resumes when B is reached through A", async () => {
    const storage = memoryStorage();
    routedPendingEnds(directB, storage).add({ address: "t7", pid: 70, created: 500, at: NOW });
    expect(routedPendingEnds(throughA, storage).list()).toEqual([
      { address: "build-box/t7", pid: 70, created: 500, at: NOW },
    ]);
    const { asked, calls } = recorder();
    await resumeEnds(routedPendingEnds(throughA, storage), () => Promise.resolve(facts("finished", 70)), calls);
    expect(asked).toEqual(["rm build-box/t7"]);
    expect(routedPendingEnds(directB, storage).list()).toEqual([]);
  });

  test("a record kept the old way, with a machine prefix under the core it was asked through, still resumes there", async () => {
    const storage = memoryStorage();
    pendingEnds("core-a", storage).add({ address: "build-box/t7", pid: 70, created: 500, at: NOW });
    const { asked, calls } = recorder();
    await resumeEnds(routedPendingEnds(throughA, storage), () => Promise.resolve(facts("finished", 70)), calls);
    expect(asked).toEqual(["rm build-box/t7"]);
    expect(pendingEnds("core-a", storage).list()).toEqual([]);
  });

  test("an End asked again where an old record sits takes that record over, so the terminal has one and it settles", () => {
    const storage = memoryStorage();
    pendingEnds("core-a", storage).add({ address: "build-box/t7", pid: 1, created: 1, at: NOW });
    const ends = routedPendingEnds(throughA, storage);
    ends.add({ address: "build-box/t7", pid: 70, created: 500, at: NOW });
    expect(pendingEnds("core-a", storage).list()).toEqual([]);
    expect(ends.list()).toEqual([{ address: "build-box/t7", pid: 70, created: 500, at: NOW }]);
    // What recordedEnd does when its End settles, either way: nothing of that terminal is left behind (#1278).
    ends.remove("build-box/t7");
    expect(ends.list()).toEqual([]);
    expect(pendingEnds("core-b", storage).list()).toEqual([]);
  });

  test("removing an old record does not take the one the name's machine now holds for its own terminal", () => {
    const storage = memoryStorage();
    pendingEnds("core-a", storage).add({ address: "build-box/t7", pid: 1, created: 1, at: NOW });
    pendingEnds("core-b", storage).add({ address: "t7", pid: 70, created: 500, at: NOW });
    routedPendingEnds(throughA, storage).remove("build-box/t7", { pid: 1, created: 1 });
    expect(pendingEnds("core-a", storage).list()).toEqual([]);
    expect(pendingEnds("core-b", storage).list()).toEqual([{ address: "t7", pid: 70, created: 500, at: NOW }]);
  });

  test("an End that settles while an older tab wrote the old way for the same terminal leaves neither record (#1278)", () => {
    const storage = memoryStorage();
    const ends = routedPendingEnds(throughA, storage);
    const end = { address: "build-box/t7", pid: 70, created: 500, at: NOW };
    ends.add(end);
    // An older tab of this browser, before #2288, records the same terminal under the core it asked through.
    pendingEnds("core-a", storage).add(end);
    ends.remove(end.address, end);
    expect(pendingEnds("core-a", storage).list()).toEqual([]);
    expect(pendingEnds("core-b", storage).list()).toEqual([]);
  });
});
