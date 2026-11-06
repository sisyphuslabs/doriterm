import { describe, expect, test } from "bun:test";
import { buildPairingUrl, hostIdOf } from "@doriface/crypto";
import type { MenuItemConstructorOptions } from "electron";
import { contextMenuTemplate } from "../src/config/context-menu.ts";
import { APP_ORIGIN } from "../src/config/origin.ts";
import { routeWindowOpen } from "../src/config/window-open.ts";
import { menuTemplate, type MenuOptions } from "../src/main/menu.ts";
import { acceleratorOf } from "../src/main/shell-menu.ts";

const roles = (items: readonly MenuItemConstructorOptions[]): string[] =>
  items.map((item) => item.role ?? item.type ?? item.label ?? "");

const submenuOf = (item: MenuItemConstructorOptions | undefined): MenuItemConstructorOptions[] =>
  Array.isArray(item?.submenu) ? item.submenu : [];

const noop = (): void => undefined;
const options = (platform: MenuOptions["platform"], more: Partial<MenuOptions> = {}): MenuOptions => ({
  platform,
  openExternal: noop,
  openSettings: noop,
  keys: new Map(),
  runAction: noop,
  ...more,
});

describe("menus", () => {
  const flags = { canCut: true, canCopy: false, canPaste: true };

  test("a text field gets native Cut, Copy, Paste and Select All; selected text gets Copy; elsewhere nothing", () => {
    const field = contextMenuTemplate({ isEditable: true, selectionText: "", editFlags: flags });
    expect(roles(field)).toEqual(["cut", "copy", "paste", "separator", "selectAll"]);
    expect(field.map((item) => item.enabled)).toEqual([true, false, true, undefined, undefined]);
    expect(roles(contextMenuTemplate({ isEditable: false, selectionText: "ls -la", editFlags: flags }))).toEqual([
      "copy",
    ]);
    expect(contextMenuTemplate({ isEditable: false, selectionText: " ", editFlags: flags })).toEqual([]);
  });

  test("the macOS app menu opens Settings, and the page's keymap owns its shortcut", () => {
    const opened: string[] = [];
    const menu = menuTemplate(options("darwin", { openSettings: () => opened.push("settings") }));
    expect(roles(menu)).toEqual(["appMenu", "File", "editMenu", "Shell", "View", "windowMenu", "help"]);
    const app = submenuOf(menu[0]);
    expect(roles(app)).toEqual([
      "about",
      "separator",
      "Settings…",
      "separator",
      "services",
      "separator",
      "hide",
      "hideOthers",
      "unhide",
      "separator",
      "quit",
    ]);
    const settings = app[2];
    expect(settings).toMatchObject({ accelerator: "CommandOrControl+,", registerAccelerator: false });
    settings?.click?.(Object.create(null), undefined, Object.create(null));
    expect(opened).toEqual(["settings"]);
  });

  test("macOS Close Window takes Ghostty's Cmd+Shift+W and leaves Cmd+W to the page, which closes panes with it", () => {
    const close = submenuOf(menuTemplate(options("darwin"))[1]).find((item) => item.label === "Close Window");
    expect(close).toMatchObject({ accelerator: "CommandOrControl+Shift+W" });
    expect(close?.registerAccelerator).toBeUndefined();
    const closed: string[] = [];
    const window = { close: () => void closed.push("window") };
    close?.click?.(Object.create(null), Object.assign(Object.create(null), window), Object.create(null));
    expect(closed).toEqual(["window"]);
  });

  test("the Shell menu lists the pane and tab actions with the page's live shortcuts, and runs them in the page", () => {
    const ran: string[] = [];
    const keys = new Map([
      ["pane.split:right", "super+d"],
      ["pane.split:down", "super+shift+d"],
      ["pane.go:left", "super+alt+left"],
    ]);
    const shell = submenuOf(menuTemplate(options("darwin", { keys, runAction: (id) => ran.push(id) }))[3]);
    expect(roles(shell)).toEqual([
      "New Tab",
      "separator",
      "Split Right",
      "Split Down",
      "separator",
      "Select Pane",
      "Swap Pane",
      "Resize Pane",
      "Equalize Panes",
      "Zoom Pane",
      "separator",
      "Close Pane",
      "Close Tab",
      "separator",
      "Select Space",
      "Previous Space",
      "Next Space",
    ]);
    expect(shell[2]).toMatchObject({ accelerator: "Command+D", registerAccelerator: false });
    expect(shell[3]).toMatchObject({ accelerator: "Command+Shift+D", registerAccelerator: false });
    expect(submenuOf(shell[5])[0]).toMatchObject({ label: "Left", accelerator: "Command+Option+Left" });
    expect(shell[0]?.accelerator).toBeUndefined();
    shell[3]?.click?.(Object.create(null), undefined, Object.create(null));
    expect(ran).toEqual(["pane.split:down"]);
  });

  test("Select Space lists the nine space chords with their live keys, and each runs its own space action", () => {
    const ran: string[] = [];
    const keys = new Map([
      ["space.select:1", "ctrl+1"],
      ["space.select:2", "ctrl+2"],
      ["space.prev", "alt+super+["],
      ["space.next", "alt+super+]"],
    ]);
    const shell = submenuOf(menuTemplate(options("darwin", { keys, runAction: (id) => ran.push(id) }))[3]);
    const select = shell.find((item) => item.label === "Select Space");
    expect(submenuOf(select).map((item) => item.label)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(submenuOf(select)[1]).toMatchObject({ accelerator: "Ctrl+2", registerAccelerator: false });
    // The page reports triggers normalized (trigger.ts), so the modifiers reach Electron in that order.
    expect(shell.find((item) => item.label === "Next Space")).toMatchObject({ accelerator: "Option+Command+]" });
    submenuOf(select)[1]?.click?.(Object.create(null), undefined, Object.create(null));
    shell.find((item) => item.label === "Previous Space")?.click?.(Object.create(null), undefined, Object.create(null));
    expect(ran).toEqual(["space.select:2", "space.prev"]);
  });

  test("a trigger becomes Electron's accelerator, and one Electron cannot name shows none", () => {
    expect(acceleratorOf("ctrl+shift+o", "linux")).toBe("Ctrl+Shift+O");
    expect(acceleratorOf("ctrl+alt+up", "win32")).toBe("Ctrl+Alt+Up");
    expect(acceleratorOf("super+ctrl+=", "darwin")).toBe("Command+Ctrl+=");
    expect(acceleratorOf("super+shift+enter", "darwin")).toBe("Command+Shift+Return");
    expect(acceleratorOf("ctrl+ä", "linux")).toBeUndefined();
  });

  test("Linux and Windows keep the standard roles, with the Shell menu after Edit", () => {
    expect(roles(menuTemplate(options("linux")))).toEqual([
      "fileMenu",
      "editMenu",
      "Shell",
      "View",
      "windowMenu",
      "help",
    ]);
  });

  test("View's text-size items run the page's terminal text-size actions and leave their keys to the page", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const steps: string[] = [];
      const menu = menuTemplate(options(platform, { runAction: (action) => steps.push(action) }));
      const view = submenuOf(menu.find((item) => item.label === "View"));
      expect(roles(view)).toEqual([
        "reload",
        "forceReload",
        "toggleDevTools",
        "separator",
        "Default Text Size",
        "Bigger Text",
        "Smaller Text",
        "separator",
        "togglefullscreen",
      ]);
      const zoomItems = view.filter((item) => item.id?.startsWith("font-size-"));
      expect(zoomItems.map((item) => [item.id, item.accelerator, item.registerAccelerator])).toEqual([
        ["font-size-reset", "CommandOrControl+0", false],
        ["font-size-increase", "CommandOrControl+Plus", false],
        ["font-size-decrease", "CommandOrControl+-", false],
      ]);
      for (const item of zoomItems) item.click?.(Object.create(null), undefined, Object.create(null));
      expect(steps).toEqual(["app.zoom_reset", "app.zoom_in", "app.zoom_out"]);
    }
  });
});

describe("window.open and new-window link clicks", () => {
  test("an app page navigates the one window to its path instead of opening another", () => {
    expect(routeWindowOpen("app://doriface/pair?x=1#h", APP_ORIGIN)).toEqual({ kind: "navigate", path: "/pair?x=1#h" });
    expect(routeWindowOpen("http://127.0.0.1:5173/settings", "http://127.0.0.1:5173")).toEqual({
      kind: "navigate",
      path: "/settings",
    });
  });

  test("an allowlisted link goes to the browser and anything else goes nowhere", () => {
    expect(routeWindowOpen("https://github.com/sisyphuslabs/doriterm#readme", APP_ORIGIN)).toEqual({
      kind: "browser",
      url: "https://github.com/sisyphuslabs/doriterm#readme",
    });
    for (const url of ["https://example.com/", "app://evil/", "file:///etc/passwd", "javascript:alert(1)", "x"]) {
      expect(routeWindowOpen(url, APP_ORIGIN)).toEqual({ kind: "none" });
    }
  });

  test("the web app's pairing link pairs in the app, and a lookalike of it does not", () => {
    const signPub = new Uint8Array(32).map((_, index) => (index * 37 + 11) % 256);
    const link = buildPairingUrl({
      webOrigin: "https://doriface.omo.dev",
      hostId: hostIdOf(signPub),
      noiseStaticPub: new Uint8Array(32).map((_, index) => (index * 53 + 7) % 256),
      signPub,
      linkSecret: new Uint8Array(32).fill(7),
      relayUrl: "wss://relay.invalid",
    });
    expect(routeWindowOpen(link, APP_ORIGIN)).toEqual({ kind: "pair", fragment: link.slice(link.indexOf("#")) });
    expect(routeWindowOpen(link.replace("doriface.omo.dev", "x.doriface.omo.dev"), APP_ORIGIN)).toEqual({
      kind: "none",
    });
  });
});
