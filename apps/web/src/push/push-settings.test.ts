import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { DEFAULT_PUSH_PREFS } from "@doriface/protocol";
import { DEFAULT_SETTINGS } from "../connection/settings.ts";
import { deviceStore, memoryStore } from "../storage/idb.ts";
import { pushChannel } from "./push-channel.ts";
import { loadPushRoute, savePushRoute } from "./push-route.ts";
import { pushSettings } from "./push-settings.ts";
import { browserRegistrar } from "./registrar.ts";

afterEach(() => mock.restore());

for (const action of ["turnOn", "turnOff"] as const) {
  test(`a successful ${action} clears a failed notification move, including later operations (#1208)`, async () => {
    const store = memoryStore();
    spyOn(deviceStore, "get").mockImplementation(store.get);
    spyOn(deviceStore, "put").mockImplementation(store.put);
    spyOn(browserRegistrar, "permission").mockResolvedValue("granted");
    spyOn(browserRegistrar, "requestPermission").mockResolvedValue("granted");
    spyOn(browserRegistrar, "current").mockResolvedValue({
      endpoint: "https://push.invalid/device",
      matches: () => true,
    });
    spyOn(browserRegistrar, "subscribe").mockResolvedValue({
      endpoint: "https://push.invalid/device",
      p256dh: "key",
      auth: "auth",
    });
    spyOn(browserRegistrar, "unsubscribe").mockResolvedValue();
    spyOn(pushChannel, "reset").mockImplementation(() => undefined);
    const request = spyOn(pushChannel, "requestOnce").mockImplementation(async (line) =>
      line.t === "hello" ? { t: "ready", vapidKey: "key", subscriptions: [] } : { t: "ok" },
    );
    // Reset the previous move with no saved route, then fail after the old route has been removed.
    await pushSettings.retarget(DEFAULT_SETTINGS);
    await savePushRoute({ mode: "loopback", pushUrl: "ws://localhost/v1/push", token: "old" });
    request.mockImplementation(async (line) => {
      if (line.t === "hello") throw new Error("the new host did not answer");
      return { t: "ok" };
    });
    await pushSettings.retarget({
      ...DEFAULT_SETTINGS,
      mode: "loopback",
      loopbackUrl: "ws://localhost/v1/hc",
      token: "new",
    });
    expect(await loadPushRoute()).toBeUndefined();
    expect(pushSettings.view.error).toBe("Could not move notifications to the new host. the new host did not answer");
    request.mockImplementation(async (line) =>
      line.t === "hello" ? { t: "ready", vapidKey: "key", subscriptions: [] } : { t: "ok" },
    );

    await pushSettings[action]();
    expect(pushSettings.view).toMatchObject({ on: action === "turnOn", busy: null, error: null });
    await pushSettings.setPrefs(DEFAULT_PUSH_PREFS);
    expect(pushSettings.view.error).toBeNull();
  });
}
