import { ToastProvider, ToastViewport, TooltipProvider } from "@doriface/ui";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { appearanceStore, startAppearance } from "./appearance/appearance.ts";
import { checkBaseline } from "./baseline.ts";
import { CrashProbe } from "./crash/crash-probe.ts";
import { CrashScreen } from "./crash/crash-screen.tsx";
import { RenderBoundary } from "./crash/render-boundary.tsx";
import { DIRECT_PATH_ENABLED } from "./connection/direct-switch.ts";
import { connectionStore } from "./connection/store.ts";
import {
  closeDesktopWindow,
  desktopBridge,
  directForwardBridge,
  installDesktopUpdate,
  onDesktopNavigate,
  onDesktopUpdateReady,
  onDesktopPairingLink,
  onDesktopRunAction,
  setDesktopBackground,
} from "./desktop/bridge.ts";
import { bootConnection, startFailure } from "./desktop/local-host.ts";
import { captureInstallPrompt } from "./device/install.ts";
import { TerminalStyle } from "./ghostty/terminal-style.tsx";
import { PAIR_PATH, pairingLink } from "./pair/link-capture.ts";
import { removeServiceWorkers } from "./pwa/remove-service-workers.ts";
import { isNativeShell, paintAppBars } from "./native/shell.ts";
import { captureNotice, listenForAppNotices, listenForDesktopNotices, listenForNotices } from "./push/notice-open.ts";
import { followConnection } from "./push/push-settings.ts";
import { runAction, setActionFallback, useKeymapDispatcher } from "./keys/dispatcher.ts";
import { reportMenuKeys } from "./keys/menu-keys.ts";
import { router } from "./router.tsx";
import { guardedSessionStorage } from "./storage/guarded.ts";
import { reloadIntoWaitingWorker, resumeUpdate } from "./update/reload-into-waiting.ts";
import { updateStore } from "./update/update-store.ts";
import { stepTerminalFont, takesTextSizeKey } from "./workspace/use-app-actions.ts";
import { restoreMembership } from "./mesh/membership-state.ts";
import { followRoster } from "./mesh/roster-refresh.ts";

// First: a browser below the baseline is told to update before the app starts or connects (#556).
checkBaseline();
startAppearance();
captureInstallPrompt();
// The desktop shell serves the app from its own app: scheme; an offline cache there only reloads the window,
// so earlier desktop builds' workers and caches are removed instead. The iOS and Android apps carry the build
// themselves and push through APNs and FCM (#705), so they run no worker either.
/**
 * A tapped notification's pane opens in the workspace. Already there, nothing navigates: the pane's own open records
 * its entry (a phone's ?t=), so a push here left a dead list entry behind the terminal (#999). From another screen
 * (Settings) the workspace takes that screen's entry rather than adding one.
 */
const toWorkspace = (): void => {
  if (router.state.location.pathname !== "/") void router.navigate({ to: "/", replace: true });
};
const native = isNativeShell();
if (!native && (location.protocol === "https:" || location.protocol === "http:")) {
  // A new worker waits until Reload to update (the sidebar's Settings dot says one does), so no page is swapped mid-use.
  const updateDeps = {
    workers: navigator.serviceWorker,
    reload: () => location.reload(),
    storage: guardedSessionStorage(),
    after: (ms: number, run: () => void) => void setTimeout(run, ms),
  };
  registerSW({
    immediate: true,
    onNeedRefresh: () =>
      updateStore.set({
        apply: "reload",
        run: () => void reloadIntoWaitingWorker(updateDeps),
      }),
  });
  void resumeUpdate(updateDeps);
  // A tapped notification opens the app at /?notice=<id>, or reaches an open window as a message.
  captureNotice();
  listenForNotices(toWorkspace);
  followConnection();
} else {
  void removeServiceWorkers();
  if (native) {
    void listenForAppNotices(toWorkspace);
    followConnection();
    // The app's status and navigation bars take the theme in view, as the desktop window does.
    paintBars();
    appearanceStore.subscribe(paintBars);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paintBars);
  }
}
const desktop = desktopBridge();
// This computer's host, if it dies while the app runs, is started again before the link to it is tried again (#515).
if (desktop !== null)
  connectionStore.restartsLocalHost({ start: () => desktop.startLocalHost(), failure: startFailure });
if (desktop === null) {
  void restoreMembership().then(() => {
    followRoster();
    return bootConnection(desktop, connectionStore);
  });
} else {
  void bootConnection(desktop, connectionStore);
}
/** Hands the page background to the iOS or Android shell, which paints the system bars around the page with it. */
function paintBars(): void {
  paintAppBars(getComputedStyle(document.documentElement).getPropertyValue("--background").trim());
}
/** Hands the page background to the desktop shell, which paints the window with it now and at the next launch. */
function paintWindow(): void {
  setDesktopBackground(getComputedStyle(document.documentElement).getPropertyValue("--background").trim());
}

onDesktopNavigate((path) => router.history.push(path));
onDesktopUpdateReady((version) => updateStore.set({ apply: "restart", version, run: () => installDesktopUpdate() }));
// Screens with no workspace (Settings, pairing) handle no text-size action, so the text-size keys (and the desktop
// app's View menu) step the terminal text from here, as Settings > Appearance hints, in a browser too (#859); the window
// itself is never zoomed (#388). The workspace and Settings take these keys themselves, so in a browser this fallback is
// reached only where no screen shows what a step changes, and there the page zooms (#1162).
for (const action of ["app.zoom_in", "app.zoom_out", "app.zoom_reset"]) {
  setActionFallback(action, () => (takesTextSizeKey(desktop !== null) ? stepTerminalFont(action) : false));
}
if (desktopBridge() !== null) {
  // The desktop app's Close Window leaves Cmd+W to the keymap; with no pane, tab or Settings to close, it closes the window.
  setActionFallback("tab.close", () => closeDesktopWindow());
  setActionFallback("pane.close", () => closeDesktopWindow());
  // The Shell menu runs the page's own actions and shows the page's own keys for them.
  onDesktopRunAction((action) => void runAction(action));
  // A clicked notification opens its pane in the workspace, from Settings too.
  listenForDesktopNotices(toWorkspace);
  reportMenuKeys();
  // The shell may forward bytes to this page's saved Direct address and nothing else (#449). With the direct path off
  // (#2070) it is told no target at all, so a saved address is not even handed to the shell.
  const forwarder = directForwardBridge();
  if (forwarder !== null) {
    const reportTarget = (): void =>
      void forwarder.setTarget(DIRECT_PATH_ENABLED ? connectionStore.settings.directUrl : "");
    reportTarget();
    connectionStore.subscribe(reportTarget);
  }
  paintWindow();
  appearanceStore.subscribe(paintWindow);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paintWindow);
}
// Leaving the pair route forgets the link; coming back without one asks for a link or code again.
router.subscribe("onResolved", ({ toLocation }) => {
  if (toLocation.pathname !== PAIR_PATH) pairingLink.set(null);
});
// A doriface:// link or an in-app pairing link: the desktop shell hands over the fragment, never a URL to load.
onDesktopPairingLink((fragment) => {
  pairingLink.set(fragment);
  void router.navigate({ to: PAIR_PATH });
});
if (import.meta.env.DEV) void import("./dev-tools.ts");

const container = document.getElementById("root");
if (container === null) throw new Error("index.html has no #root");
function Keys() {
  useKeymapDispatcher();
  return null;
}

// Outside every provider: a render error that reaches here, from a provider too, shows the crash screen, not a blank window.
createRoot(container).render(
  <StrictMode>
    <RenderBoundary fallback={(error) => <CrashScreen error={error} />}>
      <CrashProbe region="app" />
      <TooltipProvider>
        <ToastProvider>
          <TerminalStyle />
          <Keys />
          <RouterProvider router={router} />
          <ToastViewport />
        </ToastProvider>
      </TooltipProvider>
    </RenderBoundary>
  </StrictMode>,
);
