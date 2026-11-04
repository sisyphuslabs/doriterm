import { ToastProvider, ToastViewport, TooltipProvider } from "@doriface/ui";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { appearanceStore, startAppearance } from "./appearance/appearance.ts";
import { connectionStore } from "./connection/store.ts";
import {
  closeDesktopWindow,
  desktopBridge,
  onDesktopNavigate,
  onDesktopPairingLink,
  onDesktopRunAction,
  setDesktopBackground,
  zoomDesktopWindow,
} from "./desktop/bridge.ts";
import { bootConnection } from "./desktop/local-host.ts";
import { captureInstallPrompt } from "./device/install.ts";
import { TerminalStyle } from "./ghostty/terminal-style.tsx";
import { PAIR_PATH, pairingLink } from "./pair/link-capture.ts";
import { removeServiceWorkers } from "./pwa/remove-service-workers.ts";
import { runAction, setActionFallback, useKeymapDispatcher } from "./keys/dispatcher.ts";
import { reportMenuKeys } from "./keys/menu-keys.ts";
import { router } from "./router.tsx";

startAppearance();
captureInstallPrompt();
// The desktop shell serves the app from its own app: scheme; an offline cache there only reloads the window,
// so earlier desktop builds' workers and caches are removed instead.
if (location.protocol === "https:" || location.protocol === "http:") registerSW({ immediate: true });
else void removeServiceWorkers();
void bootConnection(desktopBridge(), connectionStore);
/** Hands the page background to the desktop shell, which paints the window with it now and at the next launch. */
function paintWindow(): void {
  setDesktopBackground(getComputedStyle(document.documentElement).getPropertyValue("--background").trim());
}

onDesktopNavigate((path) => router.history.push(path));
if (desktopBridge() !== null) {
  // The desktop app's Close Window leaves Cmd+W to the keymap; with no pane, tab or Settings to close, it closes the window.
  setActionFallback("tab.close", () => closeDesktopWindow());
  setActionFallback("pane.close", () => closeDesktopWindow());
  // The Shell menu runs the page's own actions and shows the page's own keys for them.
  onDesktopRunAction((action) => void runAction(action));
  reportMenuKeys();
  // The View menu shows the zoom keys without registering them, so on Linux and Windows only the keymap zooms. Screens
  // with no workspace (Settings, pairing) handle no zoom action, so the window zooms from here.
  setActionFallback("app.zoom_in", () => zoomDesktopWindow("in"));
  setActionFallback("app.zoom_out", () => zoomDesktopWindow("out"));
  setActionFallback("app.zoom_reset", () => zoomDesktopWindow("reset"));
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

createRoot(container).render(
  <StrictMode>
    <TooltipProvider>
      <ToastProvider>
        <TerminalStyle />
        <Keys />
        <RouterProvider router={router} />
        <ToastViewport />
      </ToastProvider>
    </TooltipProvider>
  </StrictMode>,
);
