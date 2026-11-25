import { expect, test } from "bun:test";
import { keepStorage, keepStorageOnceOpen } from "./keep-storage.ts";

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

// #2759: a device paired with a code never asked for persistent storage, so iOS could clear its key and settings.
test("asks to keep storage each time the connection opens, until it is kept", async () => {
  const listeners = new Set<() => void>();
  let phase = "connecting";
  const store = {
    get state() {
      return { phase };
    },
    subscribe: (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener)),
  };
  const results = ["best-effort", "kept"] as const;
  let asked = 0;
  keepStorageOnceOpen(store, async () => results[asked++] ?? "kept");
  const emit = async (next: string) => {
    phase = next;
    for (const listener of listeners) listener();
    await Promise.resolve();
  };
  await emit("open");
  expect(asked).toBe(1);
  await emit("failed");
  await emit("open");
  expect(asked).toBe(2);
  await emit("failed");
  await emit("open");
  expect(asked).toBe(2);
  expect(listeners.size).toBe(0);
});
