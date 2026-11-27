import { expect, test } from "bun:test";
import { keepStorage, keepStorageOnceOpen, storageKeepingStore } from "./keep-storage.ts";

function manager(persisted: boolean, grants: boolean) {
  const calls = { persist: 0 };
  return {
    calls,
    manager: {
      persisted: async () => persisted,
      persist: async () => {
        calls.persist += 1;
        return grants;
      },
    },
  };
}

test.each([
  { persisted: true, grants: false, result: "kept", asks: 0 },
  { persisted: false, grants: true, result: "kept", asks: 1 },
  { persisted: false, grants: false, result: "best-effort", asks: 1 },
] as const)("storage persisted=$persisted, granted=$grants: $result", async ({ persisted, grants, result, asks }) => {
  const fake = manager(persisted, grants);
  expect(await keepStorage(fake.manager)).toBe(result);
  expect(fake.calls.persist).toBe(asks);
});

test("a browser without the storage manager reports it unsupported instead of failing", async () => {
  expect(await keepStorage(undefined)).toBe("unsupported");
});

function openingStore(initial: string) {
  const listeners = new Set<() => void>();
  let phase = initial;
  return {
    listeners,
    store: {
      get state() {
        return { phase };
      },
      subscribe: (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener)),
    },
    emit: async (next: string) => {
      phase = next;
      for (const listener of listeners) listener();
      await Promise.resolve();
    },
  };
}

// iOS cleared a Home Screen app's storage again days after #2759 asked once: a launch that holds an identity asks
// before any connection opens, and only once per launch.
test("a launch that holds an identity asks as soon as the store leaves unconfigured, once", async () => {
  const { store, emit } = openingStore("unconfigured");
  let asked = 0;
  keepStorageOnceOpen(store, async () => (asked++, "best-effort"));
  expect(asked).toBe(0);
  await emit("connecting");
  expect(asked).toBe(1);
  await emit("failed");
  await emit("connecting");
  expect(asked).toBe(1);
});

test("a launch that never configured a connection does not ask", async () => {
  const { store, emit } = openingStore("unconfigured");
  let asked = 0;
  keepStorageOnceOpen(store, async () => (asked++, "kept"));
  await emit("unconfigured");
  expect(asked).toBe(0);
});

test("each answer is kept for Settings to show", async () => {
  const fake = manager(false, false);
  expect(await keepStorage(fake.manager)).toBe("best-effort");
  expect(storageKeepingStore.value).toBe("best-effort");
  expect(await keepStorage(manager(true, false).manager)).toBe("kept");
  expect(storageKeepingStore.value).toBe("kept");
});

// #2759: a device paired with a code never asked for persistent storage, so iOS could clear its key and settings.
test("asks to keep storage each time the connection opens, until it is kept", async () => {
  const { store, emit, listeners } = openingStore("connecting");
  const results = ["best-effort", "best-effort", "kept"] as const;
  let asked = 0;
  keepStorageOnceOpen(store, async () => results[asked++] ?? "kept");
  // The launch asks once (it holds a connection); each open asks again until the browser keeps the storage.
  expect(asked).toBe(1);
  await emit("open");
  expect(asked).toBe(2);
  await emit("failed");
  await emit("open");
  expect(asked).toBe(3);
  await emit("failed");
  await emit("open");
  expect(asked).toBe(3);
  expect(listeners.size).toBe(0);
});
