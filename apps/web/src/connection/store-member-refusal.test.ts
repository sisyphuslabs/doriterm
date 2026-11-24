import { expect, test } from "bun:test";
import type { HcConnection } from "@doriface/client";
import { DeviceNotPairedError, type OpenConnection } from "./connect.ts";
import { type ConnectionSettings, DEFAULT_SETTINGS } from "./settings.ts";

// store.ts builds the app's store from localStorage as it loads; bun has none, so an empty one stands in for that load only.
Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined } });
const { ConnectionStore } = await import("./store.ts");
Reflect.deleteProperty(globalThis, "localStorage");

const MEMBERS = [
  { hostId: "paired", hostName: "studio", hostKey: "kp", directUrl: "" },
  { hostId: "other", hostName: "laptop", hostKey: "ko", directUrl: "" },
] as const;
const SETTINGS: ConnectionSettings = {
  ...DEFAULT_SETTINGS,
  mode: "relay",
  hostId: "paired",
  hostKey: "kp",
  members: MEMBERS,
};

const connection = {
  hello: { core: { id: "c0re", name: "studio" } },
  onClose: () => () => undefined,
  close: () => undefined,
} as unknown as HcConnection;

type Store = InstanceType<typeof ConnectionStore>;

const settled = (store: Store, seen: Error[] = []): Promise<Store["state"]> =>
  new Promise((resolve) => {
    const off = store.subscribe(() => {
      const state = store.state;
      if (state.phase === "failed" && state.retryInMs !== null) {
        seen.push(state.error);
        queueMicrotask(() => store.retryNow());
      } else if (state.phase === "open" || state.phase === "failed") {
        off();
        resolve(state);
      }
    });
  });

// #2759: after a relay session ended, the retry moved to another member of the roster, which never paired this phone and
// refused it as an unknown device (4401). That refusal was final, so the app asked to pair again although the host it is
// paired with still listed it, and the selection stayed on the member that does not know it.
test("a 4401 from a member that never paired this device moves on, and the paired host is reached again", async () => {
  const asked: string[] = [];
  const store = new ConnectionStore(SETTINGS, ((settings: ConnectionSettings): Promise<OpenConnection> => {
    asked.push(settings.hostId);
    if (asked.length === 1) return Promise.reject(new Error("no answer"));
    if (settings.hostId === "other") return Promise.reject(new DeviceNotPairedError());
    return Promise.resolve({ connection, path: "relay" });
  }) as never);
  const shown: Error[] = [];
  const done = settled(store, shown);
  store.start();
  const state = await done;
  store.stop();
  expect(state.phase).toBe("open");
  expect(asked).toEqual(["paired", "other", "paired"]);
  expect(store.settings.hostId).toBe("paired");
  expect(shown.some((error) => error instanceof DeviceNotPairedError)).toBe(false);
});

test("when every member refuses this device as unknown, it is not paired and the app says so", async () => {
  const asked: string[] = [];
  const store = new ConnectionStore(SETTINGS, ((settings: ConnectionSettings): Promise<OpenConnection> => {
    asked.push(settings.hostId);
    return Promise.reject(new DeviceNotPairedError());
  }) as never);
  const done = settled(store);
  store.start();
  const state = await done;
  store.stop();
  expect(state.phase === "failed" && state.error).toBeInstanceOf(DeviceNotPairedError);
  expect(new Set(asked)).toEqual(new Set(["paired", "other"]));
});
