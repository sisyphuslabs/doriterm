import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { DEFAULT_PUSH_PREFS } from "@doriface/protocol";
import { type ConnectionSettings, DEFAULT_SETTINGS } from "../connection/settings.ts";
import { deviceStore, memoryStore } from "../storage/idb.ts";
import { pushChannel } from "./push-channel.ts";
import { loadPushRoute, savePushRoute } from "./push-route.ts";
import { pushSettings } from "./push-settings.ts";
import { browserRegistrar } from "./registrar.ts";

afterEach(() => mock.restore());

const loopback = (loopbackUrl: string, token: string): ConnectionSettings => ({
  ...DEFAULT_SETTINGS,
  mode: "loopback",
  loopbackUrl,
  token,
});

// #1210: the e2e moves back to the same host, which settles through `sameRoute`; this moves to a different host for real.
test("a move to a different host that goes through clears the last move's failure, for later operations too", async () => {
  const store = memoryStore();
  spyOn(deviceStore, "get").mockImplementation(store.get);
  spyOn(deviceStore, "put").mockImplementation(store.put);
  spyOn(browserRegistrar, "permission").mockResolvedValue("granted");
  spyOn(browserRegistrar, "current").mockResolvedValue({
    endpoint: "https://push.invalid/device",
    matches: () => true,
  });
  spyOn(browserRegistrar, "subscribe").mockResolvedValue({
    endpoint: "https://push.invalid/device",
    p256dh: "key",
    auth: "auth",
  });
  spyOn(pushChannel, "reset").mockImplementation(() => undefined);
  const request = spyOn(pushChannel, "requestOnce").mockImplementation(async (line) =>
    line.t === "hello" ? { t: "ready", vapidKey: "key", subscriptions: [] } : { t: "ok" },
  );
  // A move with no saved route settles with no failure, whatever an earlier test left behind.
  await pushSettings.retarget(DEFAULT_SETTINGS);
  const hostA = { mode: "loopback", pushUrl: "ws://host-a.invalid/v1/push", token: "a" } as const;
  await savePushRoute(hostA);

  // A gateway that is not an address fails the move in view and keeps the old route (#890).
  await pushSettings.retarget(loopback("not an address", "b"));
  expect(pushSettings.view.error).toStartWith("Could not move notifications to the new host.");
  expect(await loadPushRoute()).toEqual(hostA);
  // The failure stays in view through a later operation until a move goes through (#unmoved).
  await pushSettings.setPrefs(DEFAULT_PUSH_PREFS);
  expect(pushSettings.view.error).toStartWith("Could not move notifications to the new host.");

  await pushSettings.retarget(loopback("ws://host-b.invalid/v1/hc", "b"));
  const hostB = { mode: "loopback", pushUrl: "ws://host-b.invalid/v1/push", token: "b" } as const;
  expect(await loadPushRoute()).toEqual(hostB);
  expect(request.mock.calls.filter(([line]) => line.t === "subscribe").map(([, route]) => route)).toEqual([hostB]);
  expect(pushSettings.view).toMatchObject({ on: true, busy: false, error: null });

  await pushSettings.setPrefs(DEFAULT_PUSH_PREFS);
  expect(pushSettings.view.error).toBeNull();
});
