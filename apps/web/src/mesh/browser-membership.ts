import { base64urlEncode } from "@doriface/crypto";
import { useSyncExternalStore } from "react";
import { loadBrowserIdentity, resetBrowserIdentity, type BrowserIdentity } from "../connection/browser-identity.ts";
import { connectionStore } from "../connection/store.ts";
import { DEFAULT_SETTINGS } from "../connection/settings.ts";
import { deviceStore } from "../storage/idb.ts";
import { BundleStore } from "./bundle-store.ts";
import { bundleView } from "./bundle-view.ts";

const EMPTY = bundleView([], "", { signPub: "", devicePub: "" });
const listeners = new Set<() => void>();
let bundle: BundleStore | undefined;
let loading: Promise<BundleStore> | undefined;

export const membershipSnapshot = () => bundle?.snapshot() ?? EMPTY;
export const membershipBundle = () => bundle;

export async function prepareMembership(): Promise<BundleStore> {
  if (loading !== undefined) return loading;
  loading = (async () => {
    const identity: BrowserIdentity = await loadBrowserIdentity();
    const store = new BundleStore(deviceStore, {
      signPub: base64urlEncode(identity.card.publicKey),
      devicePub: base64urlEncode(identity.device.publicKey),
    });
    await store.load();
    bundle = store;
    const changed = (): void => {
      connectionStore.setViewMembers(store.snapshot().machines);
      for (const listener of listeners) listener();
    };
    store.subscribe(changed);
    changed();
    return store;
  })();
  loading.catch(() => { loading = undefined; });
  return loading;
}

/** Empty storage is a stranger, not a failed connection and not an identity generated in the background. */
export async function restoreMembership(): Promise<void> {
  if (typeof (await deviceStore.get("mesh.current")) !== "string") return;
  await prepareMembership();
  connectionStore.start();
}

export function useBrowserMembership() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    membershipSnapshot,
  );
}

export async function forgetMembership(): Promise<void> {
  connectionStore.stop();
  await bundle?.forget();
  await deviceStore.put("mesh.join-anchor", null);
  await resetBrowserIdentity();
  bundle = undefined;
  loading = undefined;
  connectionStore.update({ ...DEFAULT_SETTINGS, relayUrl: connectionStore.settings.relayUrl });
  for (const listener of listeners) listener();
}
