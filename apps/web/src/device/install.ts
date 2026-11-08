import { useSyncExternalStore } from "react";
import { desktopBridge } from "../desktop/bridge.ts";

/** Chromium's `beforeinstallprompt` event: the browser's own install dialog, usable once. */
export interface InstallPrompt {
  prompt(): Promise<unknown>;
}

export interface InstallFacts {
  /** Already running as an installed app (display-mode standalone, or iOS's home-screen web app). */
  readonly installed: boolean;
  /** Inside doriface's desktop shell, which is already an app. */
  readonly desktop: boolean;
  /** iPhone or iPad, where Safari installs through Share > Add to Home Screen and has no prompt event. */
  readonly ios: boolean;
  readonly prompt: InstallPrompt | null;
}

/** What Settings offers: the browser's install prompt, the iOS instructions, or nothing. */
export type InstallOffer =
  | { readonly kind: "prompt"; readonly prompt: InstallPrompt }
  | { readonly kind: "ios" }
  | null;

export function installOffer(facts: InstallFacts): InstallOffer {
  if (facts.installed || facts.desktop) return null;
  if (facts.prompt !== null) return { kind: "prompt", prompt: facts.prompt };
  return facts.ios ? { kind: "ios" } : null;
}

function isPrompt(event: Event): event is Event & InstallPrompt {
  return typeof Reflect.get(event, "prompt") === "function";
}

/** Running as an installed app right now: display-mode standalone, or iOS's Home Screen web app. */
export const runsInstalled = (): boolean =>
  matchMedia("(display-mode: standalone)").matches || Reflect.get(navigator, "standalone") === true;

/** iPhone or iPad; iPadOS reports a Mac user agent, so touch points tell it apart. */
export const isIos = (): boolean =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);

let deferred: InstallPrompt | null = null;
let installed = false;
const listeners = new Set<() => void>();
let offer: InstallOffer = null;

function refresh(): void {
  offer = installOffer({
    installed: installed || runsInstalled(),
    desktop: desktopBridge() !== null,
    ios: isIos(),
    prompt: deferred,
  });
  for (const listener of listeners) listener();
}

/**
 * Keeps the browser's install prompt for the Install button instead of letting the browser show its own banner. It
 * fires once, early, so main.tsx calls this before the app renders.
 */
export function captureInstallPrompt(): void {
  addEventListener("beforeinstallprompt", (event) => {
    if (!isPrompt(event)) return;
    event.preventDefault();
    deferred = event;
    refresh();
  });
  addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    refresh();
  });
  refresh();
}

/** Opens the browser's install dialog; the prompt is spent either way, so the button goes away. */
export async function install(using: InstallPrompt): Promise<void> {
  deferred = null;
  refresh();
  await using.prompt();
}

export function useInstallOffer(): InstallOffer {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => offer,
  );
}
