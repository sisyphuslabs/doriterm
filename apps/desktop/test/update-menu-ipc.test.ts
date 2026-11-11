import { expect, test } from "bun:test";
import type { MenuItemConstructorOptions } from "electron";
import { APP_ORIGIN } from "../src/config/origin.ts";
import { updateHandlers } from "../src/main/ipc-update-handlers.ts";
import { menuTemplate, type MenuOptions } from "../src/main/menu.ts";

const noop = (): void => undefined;
const options = (platform: MenuOptions["platform"], checkForUpdates?: () => void): MenuOptions => ({
  platform,
  openExternal: noop,
  openSettings: noop,
  keys: new Map(),
  runAction: noop,
  checkForUpdates,
});
const labels = (item: MenuItemConstructorOptions | undefined): string[] =>
  (Array.isArray(item?.submenu) ? item.submenu : []).map((entry) => entry.label ?? entry.role ?? entry.type ?? "");

test("Check for Updates sits under About on macOS and in Help elsewhere, only where there is an updater", () => {
  const checked: string[] = [];
  const mac = menuTemplate(options("darwin", () => checked.push("mac")));
  expect(labels(mac[0]).slice(0, 2)).toEqual(["about", "Check for Updates…"]);
  expect(labels(mac.at(-1))).toEqual(["Doriterm on GitHub"]);
  const linux = menuTemplate(options("linux", () => checked.push("linux")));
  expect(labels(linux.at(-1))).toEqual(["Doriterm on GitHub", "Check for Updates…"]);
  const help = linux.at(-1)?.submenu;
  const item = Array.isArray(help) ? help[1] : undefined;
  item?.click?.(undefined as never, undefined, undefined as never);
  expect(checked).toEqual(["linux"]);
  expect(labels(menuTemplate(options("darwin"))[0])).not.toContain("Check for Updates…");
  expect(labels(menuTemplate(options("win32")).at(-1))).toEqual(["Doriterm on GitHub"]);
});

test("the update channel handlers refuse other origins and any channel but stable or beta", () => {
  const kept: string[] = [];
  let checks = 0;
  const handlers = updateHandlers({
    origin: APP_ORIGIN,
    status: () => ({ state: "current" }),
    channel: () => "stable",
    setChannel: (channel) => kept.push(channel) > 0,
    check: () => void (checks += 1),
  });
  const app = { senderFrame: { url: `${APP_ORIGIN}/settings` } };
  const other = { senderFrame: { url: "https://example.com/" } };
  expect(handlers.status(app)).toEqual({ state: "current" });
  expect(handlers.setChannel(app, "beta")).toBe(true);
  expect(handlers.setChannel(app, "nightly")).toBe(false);
  expect(handlers.setChannel(app, { channel: "beta" })).toBe(false);
  handlers.check(app);
  expect([kept, checks]).toEqual([["beta"], 1]);
  expect(() => handlers.setChannel(other, "beta")).toThrow("refused IPC from https://example.com/");
  expect(() => handlers.channel({ senderFrame: null })).toThrow("a detached frame");
  expect(kept).toEqual(["beta"]);
});
