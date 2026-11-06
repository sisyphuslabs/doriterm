import { app, BrowserWindow, dialog, Menu, nativeTheme, screen, session, shell, systemPreferences } from "electron";
import { installHc } from "@doriface/host/hc-install";
import electronUpdater from "electron-updater";
import { homedir } from "node:os";
import { join } from "node:path";
import { contextMenuTemplate } from "../config/context-menu.ts";
import { contentSecurityPolicy } from "../config/csp.ts";
import { DEEP_LINK_SCHEME, deepLinkArg } from "../config/deep-link.ts";
import { APP_ORIGIN, loopbackDevUrl } from "../config/origin.ts";
import { storageDirToPin } from "../config/storage.ts";
import { restorePlacement } from "../config/window-state.ts";
import { launchBackground, secureWebPreferences, windowOptions } from "../config/window.ts";
import { Channel, parsePlatform } from "../shared/bridge.ts";
import { openDeepLink, routeDeepLinksTo, takePairingLink } from "./deep-link.ts";
import { DirectForwarder } from "./direct-forward.ts";
import { applyDevCsp, hardenContents, lockPermissions } from "./harden.ts";
import { findHc, hostCommand, type HostContext, saveHc, savedHc, usualHcDirs } from "./host-command.ts";
import { registerIpc } from "./ipc.ts";
import { LocalHost } from "./local-host.ts";
import { menuTemplate } from "./menu.ts";
import { noticesSupported, showNotice } from "./notice.ts";
import { readNoticeAuthorization } from "./notice-authorization.ts";
import { requestPairOffer } from "./pair-offer.ts";
import { requestPairedDevices, revokePairedDevice } from "./devices.ts";
import { registerAppScheme, serveApp } from "./protocol.ts";
import { applyMacTitlebar } from "./titlebar.ts";
import { readSaved, rememberPlacement, savedPlacement, writeSaved } from "./window-state.ts";
import { revealWhenReady } from "./window-reveal.ts";
import { UpdateWatch } from "./updater.ts";

const platform = parsePlatform(process.platform);
const pinnedStorage = storageDirToPin(app.getPath("appData"), app.commandLine.hasSwitch("user-data-dir"));
if (pinnedStorage !== undefined) app.setPath("userData", pinnedStorage);
const devSetting = app.isPackaged ? undefined : process.env["DORIFACE_DESKTOP_DEV_URL"];
const devUrl = devSetting === undefined || devSetting === "" ? undefined : loopbackDevUrl(devSetting);
const origin = devUrl === undefined ? APP_ORIGIN : new URL(devUrl).origin;
const csp = contentSecurityPolicy({ devServer: devUrl });
const webPreferences = secureWebPreferences(join(import.meta.dirname, "preload.cjs"), app.getVersion());

/** The built web app: bundled as a resource, or overridden in a checkout. */
const webRoot = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, "web")
    : (process.env["DORIFACE_WEB_DIST"] ?? join(app.getAppPath(), "..", "web", "dist"));

const hostContext = (): HostContext => ({
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  appPath: app.getAppPath(),
  platform,
  home: homedir(),
  env: process.env,
});

const openExternal = (url: string): void => {
  shell.openExternal(url).catch((error: unknown) => console.error(`openExternal failed: ${String(error)}`));
};

let mainWindow: BrowserWindow | undefined;
/** The byte forwarder a plain `ws://` Direct address needs (#449); it lives as long as the app. */
let forwarder: DirectForwarder | undefined;
const savedFile = (name: string): string => join(app.getPath("userData"), name);

const liveWindow = (): BrowserWindow | undefined =>
  mainWindow !== undefined && !mainWindow.isDestroyed() ? mainWindow : undefined;

/** The app has one window: brings it back when it exists and creates it, at `path`, only when it does not. */
function showWindow(path = "/"): BrowserWindow {
  const window = liveWindow();
  if (window === undefined) return createWindow(path);
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return window;
}

/** Brings the one window forward (making it at `/` when there is none) and hands its page `value` once loaded. */
function sendToPage(channel: string, value: string | null): void {
  const window = showWindow();
  const contents = window.webContents;
  if (contents.isLoading()) contents.once("did-finish-load", () => contents.send(channel, value));
  else contents.send(channel, value);
}

/** Shows an app path in the one window: an in-app navigation once its page has loaded, the first page otherwise. */
function navigate(path: string): void {
  if (liveWindow() === undefined) return void showWindow(path);
  sendToPage(Channel.navigate, path);
}

const openSettings = (): void => navigate("/settings");

/** How often a long-running app looks for a release again after the check at launch. */
const UPDATE_CHECK_MS = 4 * 60 * 60 * 1000;

/** A Shell menu item runs its action in the page, as its key would. */
function runAction(action: string): void {
  liveWindow()?.webContents.send(Channel.runAction, action);
}

function showMenu(keys: ReadonlyMap<string, string>): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(menuTemplate({ platform, openExternal, openSettings, keys, runAction })),
  );
}

function createWindow(path: string): BrowserWindow {
  const placementFile = savedFile("window-placement.json");
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  const placement = restorePlacement(savedPlacement(placementFile), workAreas, screen.getPrimaryDisplay().workArea);
  const background = launchBackground(readSaved(savedFile("window-background.json")), nativeTheme.shouldUseDarkColors);
  const window = new BrowserWindow(windowOptions(platform, webPreferences, { background, placement }));
  mainWindow = window;
  revealWhenReady({
    show: () => window.show(),
    isVisible: () => window.isVisible(),
    isDestroyed: () => window.isDestroyed(),
    onReady: (listener) => void window.once("ready-to-show", listener),
    onClosed: (listener) => void window.once("closed", listener),
  });
  if (platform === "darwin") applyMacTitlebar(window);
  rememberPlacement(window, placementFile);
  window.webContents.on("context-menu", (_event, params) => {
    const template = contextMenuTemplate(params);
    if (template.length > 0) Menu.buildFromTemplate(template).popup({ window });
  });
  // A reload, a navigation or a crash ends every forward the page held: the next page asks for its own (#449).
  const windowId = window.webContents.id;
  const dropForwards = (): void => forwarder?.dropWindow(windowId);
  window.webContents.on("did-start-loading", dropForwards);
  window.webContents.on("render-process-gone", dropForwards);
  window.on("closed", () => {
    dropForwards();
    if (mainWindow === window) mainWindow = undefined;
  });
  window.loadURL(new URL(path, devUrl ?? `${APP_ORIGIN}/`).href).catch((error: unknown) => {
    console.error(`failed to load the app: ${String(error)}`);
  });
  return window;
}

function setWindowBackground(color: string): void {
  liveWindow()?.setBackgroundColor(color);
  writeSaved(savedFile("window-background.json"), { background: color });
}

/**
 * Deep links land in the one window: brought forward, or made when the app has none (macOS keeps running). Before the
 * app is ready there is no window yet; the one made at startup takes the waiting link when it loads.
 */
const revealWindow = () => (app.isReady() ? showWindow().webContents : undefined);

function ready(): void {
  const context = hostContext();
  const localHost = new LocalHost({
    command: hostCommand(context),
    hc: () => findHc(context, usualHcDirs(context), savedHc(savedFile("hc.json"))),
    searched: () => usualHcDirs(context),
    env: process.env,
    log: (line) => console.log(line),
  });
  app.on("will-quit", () => void localHost.stop());
  forwarder = new DirectForwarder({ origin });
  app.on("will-quit", () => void forwarder?.stop());
  // A checkout has no release feed (app-update.yml) to update from; only the packaged app looks for one.
  const updates = app.isPackaged
    ? new UpdateWatch(
        electronUpdater.autoUpdater,
        () => liveWindow()?.webContents.send(Channel.updateReady),
        (line) => console.log(line),
      )
    : undefined;
  lockPermissions(session.defaultSession, origin);
  if (devUrl === undefined) serveApp(webRoot(), csp);
  else applyDevCsp(session.defaultSession, origin, csp);
  showMenu(new Map());
  registerIpc({
    origin,
    startLocalHost: () => localHost.start(),
    pairOffer: async (request) => {
      try {
        return await requestPairOffer(await localHost.start(), request);
      } catch (error) {
        return { state: "unavailable", reason: error instanceof Error ? error.message : String(error) };
      }
    },
    pairedDevices: async () => {
      try {
        return await requestPairedDevices(await localHost.start());
      } catch (error) {
        return { state: "unavailable", reason: error instanceof Error ? error.message : String(error) };
      }
    },
    revokeDevice: async (id) => {
      try {
        return await revokePairedDevice(await localHost.start(), id);
      } catch (error) {
        return { state: "unavailable", reason: error instanceof Error ? error.message : String(error) };
      }
    },
    openExternal: (url) => shell.openExternal(url),
    setWindowBackground,
    closeWindow: () => liveWindow()?.close(),
    takePairingLink,
    setMenuKeys: showMenu,
    chooseHc: async () => {
      const window = liveWindow();
      const options = { title: "Choose herdr-core's hc", properties: ["openFile" as const] };
      const answer =
        window === undefined ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options);
      const chosen = answer.canceled ? undefined : answer.filePaths[0];
      if (chosen !== undefined) saveHc(savedFile("hc.json"), chosen);
      return chosen;
    },
    takeUpdate: () => updates?.ready ?? null,
    installUpdate: () => updates?.install() ?? false,
    // Kept as the chosen hc, so a Retry starts the one just installed even where another hc comes first on PATH.
    installHc: async (onPhase) => {
      const installed = await installHc({ home: context.home, env: process.env, onPhase });
      saveHc(savedFile("hc.json"), installed.path);
      return installed;
    },
    noticesSupported,
    noticePermission: () => readNoticeAuthorization(systemPreferences),
    // A click brings the window back (or makes it, on macOS with none left) and opens the pane in it.
    showNotice: (notice) => showNotice(notice, (terminal) => sendToPage(Channel.noticeClicked, terminal)),
    setDirectTarget: (directUrl) => forwarder?.setTarget(directUrl) ?? false,
    forwardDirect: async (windowId) => (await forwarder?.issue(windowId)) ?? { refused: "no forwarder" },
    cancelDirectForward: (url) => forwarder?.cancel(url) ?? false,
  });
  if (updates !== undefined) {
    updates.start();
    setInterval(() => updates.check(), UPDATE_CHECK_MS);
  }
  // In a checkout the executable is Electron itself, which must not become the OS handler for doriface: links.
  if (app.isPackaged) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  routeDeepLinksTo(revealWindow);
  showWindow();
  const launchLink = deepLinkArg(process.argv);
  if (launchLink !== undefined) openDeepLink(launchLink);
  app.on("activate", () => void showWindow());
}

registerAppScheme();
app.enableSandbox();
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("web-contents-created", (_event, contents) => hardenContents(contents, origin, navigate));
  app.on("open-url", (event, url) => {
    event.preventDefault();
    openDeepLink(url);
  });
  app.on("second-instance", (_event, argv) => {
    const link = deepLinkArg(argv);
    if (link !== undefined) openDeepLink(link);
    if (app.isReady()) showWindow();
  });
  app.on("window-all-closed", () => {
    if (platform !== "darwin") app.quit();
  });
  app
    .whenReady()
    .then(ready)
    .catch((error: unknown) => {
      console.error(`Doriterm failed to start: ${String(error)}`);
      app.exit(1);
    });
}
