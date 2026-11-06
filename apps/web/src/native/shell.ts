import { Capacitor, type PluginListenerHandle, registerPlugin } from "@capacitor/core";

/** What the iOS or Android app registered for push: its token, and the keys its notification code decrypts with. */
export interface NativeRegistration {
  readonly platform: "ios" | "android";
  /** The APNs device token (hex) or the FCM registration token. */
  readonly token: string;
  /** iOS: the build talks to APNs' development environment. */
  readonly sandbox: boolean;
  /** The app's P-256 public key, uncompressed, base64url (65 bytes). */
  readonly p256dh: string;
  /** The 16-byte auth secret, base64url. */
  readonly auth: string;
}

export interface NoticeTap {
  /** The app's address for the notice, as the service worker opens it: `/?notice=<id>&host=<hostId>[&answer=...]`. */
  readonly url: string;
}

/** `DorifacePush`, the plugin both apps carry (`apps/mobile`). */
export interface NativePushPlugin {
  checkPermissions(): Promise<{ readonly receive: NotificationPermission }>;
  requestPermissions(): Promise<{ readonly receive: NotificationPermission }>;
  register(): Promise<NativeRegistration>;
  current(): Promise<{ readonly registration: NativeRegistration | null }>;
  unregister(): Promise<void>;
  /** The tap that launched the app, once; later calls answer null. */
  takeLaunchTap(): Promise<{ readonly tap: NoticeTap | null }>;
  addListener(event: "noticeTap", listener: (tap: NoticeTap) => void): Promise<PluginListenerHandle>;
}

/** True only inside the iOS and Android apps; a browser and the desktop app are never native here. */
export const isNativeShell = (): boolean => Capacitor.isNativePlatform();

let plugin: NativePushPlugin | undefined;

export function nativePush(): NativePushPlugin | null {
  if (!isNativeShell()) return null;
  plugin ??= registerPlugin<NativePushPlugin>("DorifacePush");
  return plugin;
}

interface NativeShellPlugin {
  setBackground(options: { readonly color: string }): Promise<void>;
}

let shellPlugin: NativeShellPlugin | undefined;

/** Paints the app's system bars with the page background, as `setDesktopBackground` does for the desktop window. */
export function paintAppBars(color: string): void {
  if (!isNativeShell() || !/^#[\da-f]{6}$/i.test(color)) return;
  shellPlugin ??= registerPlugin<NativeShellPlugin>("DorifaceShell");
  void shellPlugin.setBackground({ color }).catch(() => undefined);
}
