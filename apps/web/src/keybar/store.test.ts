import { expect, test } from "bun:test";
import { memoryStore } from "../storage/idb.ts";
import { addPack } from "./operations.ts";
import { defaultSettings } from "./settings.ts";
import { KeyBarStore } from "./store.ts";

test("a change is stored and a new store on the same device reads it back", async () => {
  const storage = memoryStore();
  const store = new KeyBarStore(storage);
  await store.loaded;
  expect(store.settings).toEqual(defaultSettings());
  await store.update((current) => addPack(current, "tmux"));
  expect(store.settings.packs).toEqual(["tmux"]);

  const next = new KeyBarStore(storage);
  await next.loaded;
  expect(next.settings.packs).toEqual(["tmux"]);
  expect(next.settings.activePack).toBe("tmux");
});

test("a change made before the load finishes keeps what was stored", async () => {
  const storage = memoryStore();
  const first = new KeyBarStore(storage);
  await first.loaded;
  await first.update((current) => addPack(current, "navigation"));

  const store = new KeyBarStore(storage);
  const edited = store.update((current) => addPack(current, "tmux"));
  await edited;
  expect(store.settings.packs).toEqual(["navigation", "tmux"]);
});

test("an unchanged document is not written again", async () => {
  const writes: string[] = [];
  const storage = memoryStore();
  const store = new KeyBarStore({
    get: (key) => storage.get(key),
    put: async (key, value) => {
      writes.push(key);
      await storage.put(key, value);
    },
  });
  await store.loaded;
  await store.update((current) => current);
  expect(writes).toEqual([]);
  await store.update((current) => addPack(current, "tmux"));
  expect(writes).toEqual(["key-bar"]);
});

test("a store whose read failed refuses writes, so a stored bar is never overwritten", async () => {
  const store = new KeyBarStore({
    get: async () => {
      throw new Error("IndexedDB is not available");
    },
    put: async () => {
      throw new Error("must not be called");
    },
  });
  await store.loaded;
  expect(store.error?.message).toBe("IndexedDB is not available");
  await store.update((current) => addPack(current, "tmux"));
  expect(store.settings.packs).toEqual([]);
});
