import { expect, test } from "bun:test";
import { single, withValues, EMPTY_CONFIG } from "../ghostty/config.ts";
import { memoryStore } from "../storage/idb.ts";
import { TerminalConfigStore } from "../ghostty/config-store.ts";
import { followConfiguredSize, PinchFontStore, pinchedConfig } from "./pinch-font-store.ts";

test("a pinched size is kept on this device and read back by a new store", async () => {
  const storage = memoryStore();
  const store = new PinchFontStore(storage);
  await store.loaded;
  expect(store.size).toBeNull();
  await store.set(10.5);
  expect(store.size).toBe(10.5);
  const again = new PinchFontStore(storage);
  await again.loaded;
  expect(again.size).toBe(10.5);
});

test("clearing goes back to the device's default and tells observers", async () => {
  const store = new PinchFontStore(memoryStore());
  await store.loaded;
  let told = 0;
  store.subscribe(() => (told += 1));
  await store.set(16);
  await store.clear();
  expect(store.size).toBeNull();
  expect(told).toBe(2);
});

test("a stored value outside 8..24 or not a number is ignored", async () => {
  const storage = memoryStore();
  await storage.put("terminal-pinch-font-size", 40);
  const store = new PinchFontStore(storage);
  await store.loaded;
  expect(store.size).toBeNull();
  await storage.put("terminal-pinch-font-size", "12");
  const other = new PinchFontStore(storage);
  await other.loaded;
  expect(other.size).toBeNull();
});

test("changing the configured size (Settings, the zoom keys) drops the pinched one, other settings do not", async () => {
  const config = new TerminalConfigStore(memoryStore());
  const pinch = new PinchFontStore(memoryStore());
  await Promise.all([config.loaded, pinch.loaded]);
  followConfiguredSize(pinch, config);
  await pinch.set(10);
  await config.update((current) => withValues(current, "cursor-style", ["bar"]));
  expect(pinch.size).toBe(10);
  await config.update((current) => withValues(current, "font-size", ["15"]));
  expect(pinch.size).toBeNull();
});

test("the pinched size stands in for the configured font-size, and none keeps the config", () => {
  const config = withValues(EMPTY_CONFIG, "font-size", ["15"]);
  expect(single(pinchedConfig(config, 9.5), "font-size")).toBe("9.5");
  expect(pinchedConfig(config, null)).toBe(config);
});
