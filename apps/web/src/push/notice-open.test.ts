import type { PluginListenerHandle } from "@capacitor/core";
import { afterEach, describe, expect, test } from "bun:test";
import type { NativePushPlugin, NoticeTap } from "../native/shell.ts";
import { forgetNotices, hasLaunchNotice, listenForAppNotices } from "./notice-open.ts";

/** An app's push plugin whose launch tap answers when the test says so. */
function launchingPlugin(): { readonly plugin: NativePushPlugin; readonly answer: (tap: NoticeTap | null) => void } {
  const launch = Promise.withResolvers<{ readonly tap: NoticeTap | null }>();
  const plugin: NativePushPlugin = {
    checkPermissions: async () => ({ receive: "granted" }),
    requestPermissions: async () => ({ receive: "granted" }),
    register: async () => {
      throw new Error("a launch tap registers nothing");
    },
    current: async () => ({ registration: null }),
    unregister: async () => undefined,
    takeLaunchTap: () => launch.promise,
    addListener: async () => ({ remove: async () => undefined }) satisfies PluginListenerHandle,
  };
  return { plugin, answer: (tap) => launch.resolve({ tap }) };
}

const hadLocation = "location" in globalThis;
afterEach(() => {
  forgetNotices();
  if (!hadLocation) Reflect.deleteProperty(globalThis, "location");
});

describe("the notice that launched an app (#1494)", () => {
  test("is remembered once the launch tap answers, apart from the pending notice its pane takes", async () => {
    // openTapped reads the page's origin; a test has no page.
    if (!hadLocation) Reflect.set(globalThis, "location", { origin: "https://app.test" });
    const { plugin, answer } = launchingPlugin();
    const listened = listenForAppNotices(() => undefined, plugin);
    expect(hasLaunchNotice()).toBe(false);
    // The app answers in a later task, so only awaiting the launch chain itself sees the answer.
    setTimeout(() => answer({ url: `/?notice=${"a".repeat(22)}&host=host-1` }));
    await listened;
    // useNoticeOpen takes the pending notice as soon as a render runs; the start decision reads this instead.
    expect(hasLaunchNotice()).toBe(true);
  });
});
