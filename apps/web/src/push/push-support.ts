import { isNativeShell } from "../native/shell.ts";

/**
 * Where web push can work here. `install-first`: iOS and iPadOS give push only to a Home Screen web app (16.4+), so a
 * Safari tab gets an install hint instead of a switch. `desktop-app`: the desktop shell runs no service worker. The
 * iOS and Android apps push through APNs and FCM (#705), whatever their web view offers.
 */
export type PushSupport = "supported" | "install-first" | "desktop-app" | "unsupported";

export interface SupportScope {
  readonly native: boolean;
  readonly protocol: string;
  readonly push: boolean;
  readonly notifications: boolean;
  readonly serviceWorker: boolean;
  readonly ios: boolean;
  readonly standalone: boolean;
}

export function pushSupport(scope: SupportScope): PushSupport {
  if (scope.native) return "supported";
  if (scope.protocol !== "https:" && scope.protocol !== "http:") return "desktop-app";
  if (scope.push && scope.notifications && scope.serviceWorker) return "supported";
  return scope.ios && !scope.standalone ? "install-first" : "unsupported";
}

export function browserScope(): SupportScope {
  const ua = navigator.userAgent;
  // iPadOS reports a Mac user agent; touch points tell it apart.
  const ios = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  return {
    native: isNativeShell(),
    protocol: location.protocol,
    push: "PushManager" in globalThis,
    notifications: "Notification" in globalThis,
    serviceWorker: "serviceWorker" in navigator,
    ios,
    standalone: matchMedia("(display-mode: standalone)").matches || Reflect.get(navigator, "standalone") === true,
  };
}
