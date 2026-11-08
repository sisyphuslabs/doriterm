import { base64urlEncode } from "@doriface/crypto";
import { useSyncExternalStore } from "react";
import { hasBrowserIdentity, loadBrowserIdentity, resetBrowserIdentity, type BrowserIdentity } from "./identity.ts";
import { connectionStore } from "../connection/store.ts";
import { DEFAULT_SETTINGS } from "../connection/settings.ts";
import { deviceStore } from "../storage/idb.ts";
import { MembershipStore } from "./membership.ts";
import { bundleView } from "./bundle-view.ts";

const EMPTY = bundleView([], "", { signPub: "", devicePub: "" });
const listeners = new Set<() => void>();
let bundle: MembershipStore | undefined;
let loading: Promise<MembershipStore> | undefined;
let restoreFailure: string | undefined;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useMembershipFailure(): string | undefined {
  return useSyncExternalStore(subscribe, () => restoreFailure);
}

export const membershipSnapshot = () => bundle?.snapshot() ?? EMPTY;
export const membershipBundle = () => bundle;

export async function prepareMembership(): Promise<MembershipStore> {
  if (loading !== undefined) return loading;
  loading = (async () => {
    const identity: BrowserIdentity = await loadBrowserIdentity();
    const store = new MembershipStore(deviceStore, {
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
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}

/** Empty storage is a stranger, not a failed connection and not an identity generated in the background. */
export async function restoreMembership(): Promise<void> {
  try {
    restoreFailure = undefined;
    await restoreHeld();
  } catch (error) {
    restoreFailure = error instanceof Error ? error.message : String(error);
  }
  for (const listener of listeners) listener();
}

async function restoreHeld(): Promise<void> {
  const held = await new MembershipStore().read();
  if (held === undefined) return;
  if (!(await hasBrowserIdentity())) {
    await new MembershipStore().forget();
    await resetBrowserIdentity();
    connectionStore.update({ ...DEFAULT_SETTINGS, relayUrl: held.relayUrl });
    return;
  }
  connectionStore.edit({ relayUrl: held.relayUrl });
  await prepareMembership();
}

export function useBrowserMembership() {
  return useSyncExternalStore(subscribe, membershipSnapshot);
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
