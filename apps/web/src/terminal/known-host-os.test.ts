import { expect, test } from "bun:test";
import type { StorageLike } from "../storage/guarded.ts";
import { offlinePlatform, rememberedHostId, rememberHostOs } from "./known-host-os.ts";

const memory = (): StorageLike => {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
};

test("a Mac reached through a mesh, under a name with no Mac in it, keeps the Mac keys while it cannot be reached (#2385)", () => {
  const storage = memory();
  rememberHostOs(storage, "host-a", "darwin");
  expect(offlinePlatform(storage, "host-a", "m942-a")).toBe("mac");
});

test("what was remembered for one host says nothing about another", () => {
  const storage = memory();
  rememberHostOs(storage, "host-a", "darwin");
  expect(offlinePlatform(storage, "host-b", "m942-b")).toBe("other");
});

test("a host that last reported Linux is not taken for a Mac by its name", () => {
  const storage = memory();
  rememberHostOs(storage, "host-a", "linux");
  expect(offlinePlatform(storage, "host-a", "Ana-MacBook")).toBe("other");
});

test("every OS a host can report is kept, a Windows host included", () => {
  const storage = memory();
  rememberHostOs(storage, "host-w", "win32");
  expect(offlinePlatform(storage, "host-w", "MacBook-named-box")).toBe("other");
});

test("a host never reached falls back to the guess from its name", () => {
  const storage = memory();
  expect(offlinePlatform(storage, "host-a", "Ana-MacBook")).toBe("mac");
  expect(offlinePlatform(storage, "host-a", "m942-a")).toBe("other");
});

test("an OS is remembered under a host id only over the relay, never for loopback's own host", () => {
  expect(rememberedHostId({ mode: "relay", hostId: "host-a" })).toBe("host-a");
  expect(rememberedHostId({ mode: "loopback", hostId: "host-a" })).toBeUndefined();
  expect(rememberedHostId({ mode: "relay", hostId: "" })).toBeUndefined();
});
