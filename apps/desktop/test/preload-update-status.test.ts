import { expect, mock, test } from "bun:test";
import type { DorifaceBridge } from "../src/shared/bridge.ts";

/** Electron's ipcRenderer as far as onUpdateStatus uses it, counting the listeners it holds. */
const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
const ipcRenderer = {
  on(channel: string, listener: (...args: unknown[]) => void) {
    listeners.set(channel, (listeners.get(channel) ?? new Set()).add(listener));
    return ipcRenderer;
  },
  removeListener(channel: string, listener: (...args: unknown[]) => void) {
    listeners.get(channel)?.delete(listener);
    return ipcRenderer;
  },
  invoke: async () => null,
};
const held = (): number => [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
let exposed: DorifaceBridge | undefined;
mock.module("electron", () => ({
  ipcRenderer,
  contextBridge: {
    exposeInMainWorld: (_name: string, api: DorifaceBridge) => {
      exposed = api;
    },
  },
}));
await import("../src/preload/preload.ts");

test("each onUpdateStatus answers the function that removes its ipc listener again (#1982)", () => {
  if (exposed === undefined) throw new Error("the preload exposes its bridge");
  const before = held();
  const stops = [exposed.onUpdateStatus(() => undefined), exposed.onUpdateStatus(() => undefined)];
  expect(held()).toBe(before + 2);
  for (const stop of stops) stop();
  expect(held()).toBe(before);
});
