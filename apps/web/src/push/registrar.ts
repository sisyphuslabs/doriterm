import { base64urlDecode } from "@doriface/crypto";
import type { PushSubscriptionKeys } from "@doriface/protocol";
import { nativePush, type NativeRegistration } from "../native/shell.ts";
import { keysOf, sameKey } from "./subscription-keys.ts";

/** The push subscription this device holds, and whether the host's current VAPID key can post to it. */
export interface HeldKeys {
  /** Where the host posts this device's notices; the keys are read only when subscribing. */
  readonly endpoint: string;
  matches(vapidKey: string): boolean;
}

/**
 * Where this device's push subscription comes from: the browser's push manager (a service worker's subscription), or
 * the iOS and Android apps' own APNs or FCM token behind the push bridge (#705). Settings > Notifications drives
 * either the same way.
 */
export interface PushRegistrar {
  permission(): Promise<NotificationPermission>;
  /** Asks for the permission; only a click on Turn on calls it. */
  requestPermission(): Promise<NotificationPermission>;
  current(): Promise<HeldKeys | null>;
  subscribe(vapidKey: string): Promise<PushSubscriptionKeys>;
  unsubscribe(): Promise<void>;
}

const manager = async (): Promise<PushManager> => (await navigator.serviceWorker.ready).pushManager;

export const browserRegistrar: PushRegistrar = {
  permission: () => Promise.resolve(Notification.permission),
  requestPermission: () => Notification.requestPermission(),
  async current() {
    const subscription = await (await manager()).getSubscription();
    if (subscription === null) return null;
    return { endpoint: subscription.endpoint, matches: (vapidKey) => sameKey(subscription, vapidKey) };
  },
  async subscribe(vapidKey) {
    const pushManager = await manager();
    let subscription = await pushManager.getSubscription();
    if (subscription !== null && !sameKey(subscription, vapidKey)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array(base64urlDecode(vapidKey)),
    });
    return keysOf(subscription);
  },
  async unsubscribe() {
    await (await manager()).getSubscription().then((subscription) => subscription?.unsubscribe());
  },
};

/** doriface's push bridge: the host posts a native app's notices here, and it forwards them to APNs or FCM. */
export const PUSH_BRIDGE = "https://push-doriface.omo.dev";

/** The endpoint the host posts to for an app's token: the bridge route of its platform and APNs environment. */
export function nativeEndpoint(registration: Pick<NativeRegistration, "platform" | "token" | "sandbox">): string {
  const route = registration.platform === "android" ? "fcm" : registration.sandbox ? "apns-sandbox" : "apns";
  return `${PUSH_BRIDGE}/v1/${route}/${encodeURIComponent(registration.token)}`;
}

const keysOfRegistration = (registration: NativeRegistration): PushSubscriptionKeys => ({
  endpoint: nativeEndpoint(registration),
  p256dh: registration.p256dh,
  auth: registration.auth,
});

/**
 * The apps' registrar. The bridge takes any host's VAPID key, so a subscription never goes stale with the key; the app
 * keeps its own P-256 key and auth secret in the Keychain or Keystore, where its notification code decrypts with them.
 */
export function nativeRegistrar(plugin = nativePush()): PushRegistrar | null {
  if (plugin === null) return null;
  return {
    permission: async () => (await plugin.checkPermissions()).receive,
    requestPermission: async () => (await plugin.requestPermissions()).receive,
    async current() {
      const held = await plugin.current();
      return held.registration === null ? null : { endpoint: nativeEndpoint(held.registration), matches: () => true };
    },
    subscribe: async () => keysOfRegistration(await plugin.register()),
    unsubscribe: () => plugin.unregister(),
  };
}

/** The app's registrar inside the iOS and Android shells, the browser's everywhere else. */
export const pushRegistrar = (): PushRegistrar => nativeRegistrar() ?? browserRegistrar;
