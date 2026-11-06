import type { PluginListenerHandle } from "@capacitor/core";
import { parsePushClientLine } from "@doriface/protocol";
import { describe, expect, test } from "bun:test";
import type { NativePushPlugin, NativeRegistration } from "../native/shell.ts";
import { nativeEndpoint, nativeRegistrar } from "./registrar.ts";

const KEYS = { p256dh: `B${"A".repeat(86)}`, auth: "A".repeat(22) };

function fakePlugin(registration: NativeRegistration) {
  let held: NativeRegistration | null = null;
  const plugin: NativePushPlugin = {
    checkPermissions: async () => ({ receive: held === null ? "default" : "granted" }),
    requestPermissions: async () => ({ receive: "granted" }),
    register: async () => (held = registration),
    current: async () => ({ registration: held }),
    unregister: async () => void (held = null),
    takeLaunchTap: async () => ({ tap: null }),
    addListener: async () => ({ remove: async () => undefined }) satisfies PluginListenerHandle,
  };
  return plugin;
}

describe("an app's subscription points at the push bridge (#705)", () => {
  test.each([
    [
      { platform: "android", token: "fGx1:APA91b_x-y", sandbox: false },
      "https://push-doriface.omo.dev/v1/fcm/fGx1%3AAPA91b_x-y",
    ],
    [
      { platform: "ios", token: "ab".repeat(32), sandbox: false },
      `https://push-doriface.omo.dev/v1/apns/${"ab".repeat(32)}`,
    ],
    [
      { platform: "ios", token: "ab".repeat(32), sandbox: true },
      `https://push-doriface.omo.dev/v1/apns-sandbox/${"ab".repeat(32)}`,
    ],
  ] as const)("%o", (registration, endpoint) => {
    expect(nativeEndpoint(registration)).toBe(endpoint);
  });

  test("the subscribe line the host gets parses, with the app's own keys", async () => {
    const registrar = nativeRegistrar(fakePlugin({ platform: "ios", token: "ab".repeat(32), sandbox: false, ...KEYS }));
    const subscription = await registrar?.subscribe("unused: the bridge takes any VAPID key");
    const line = parsePushClientLine(
      JSON.stringify({
        t: "subscribe",
        subscription,
        prefs: { events: { input: true, permission: true, done: true, error: true }, muted: [] },
      }),
    );
    expect(line.t === "subscribe" && line.subscription).toEqual({
      endpoint: `https://push-doriface.omo.dev/v1/apns/${"ab".repeat(32)}`,
      ...KEYS,
    });
  });

  test("a held registration matches any host key; none is held after unsubscribing", async () => {
    const registrar = nativeRegistrar(fakePlugin({ platform: "android", token: "t", sandbox: false, ...KEYS }));
    expect(await registrar?.current()).toBeNull();
    await registrar?.subscribe("k1");
    const held = await registrar?.current();
    expect(held?.matches("another host key")).toBe(true);
    expect(held?.endpoint).toBe("https://push-doriface.omo.dev/v1/fcm/t");
    await registrar?.unsubscribe();
    expect(await registrar?.current()).toBeNull();
  });

  test("outside the apps there is no native registrar", () => {
    expect(nativeRegistrar(null)).toBeNull();
  });
});
