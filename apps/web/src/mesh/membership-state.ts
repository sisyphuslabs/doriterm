import { base64urlEncode } from "@doriface/crypto";
import { useSyncExternalStore } from "react";
import { connectionStore } from "../connection/store.ts";
import type { MemberTarget } from "../connection/settings.ts";
import { deviceStore } from "../storage/idb.ts";
import { bundleView, type BundleView } from "./bundle-view.ts";
import { forgetCachedIdentity, loadBrowserIdentity } from "./identity.ts";
import { DEFAULT_SLOT, slotKeys } from "./identity-slots.ts";
import { storedPublicHalves } from "./slot-authority.ts";
import type { KeyValueStore } from "../storage/idb.ts";
import { contextOf, type MeshContext } from "./mesh-context.ts";
import { MembershipStore } from "./membership.ts";

export interface HeldMesh {
  readonly slot: string;
  readonly view: BundleView;
}

const EMPTY = bundleView([], "", { signPub: "", devicePub: "" });
/** The slot of the mesh picked last; kept so a reload shows the same mesh, and its machine, again. */
export const IN_VIEW_KEY = "mesh.in-view";
const listeners = new Set<() => void>();
const stores = new Map<string, MembershipStore>();
const loading = new Map<string, Promise<MembershipStore>>();
/** One token per load in flight: a slot dropped while its load ran is not put back when that load ends. */
const tokens = new Map<string, symbol>();
/** The order the slots were loaded in, which is the record's: loads finish in any order, the list does not move. */
const order: string[] = [];
let held: readonly HeldMesh[] = [];
let inView: string | undefined;
let restoreFailure: string | undefined;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const notify = (): void => {
  for (const listener of listeners) listener();
};
// The mesh in view follows the selected machine, so a selection made anywhere (a row, failover) moves it too.
connectionStore.subscribe(notify);

/** The membership the selected machine belongs to (`contextOf`), or undefined when there is none to act for. */
export const selectedContext = (): MeshContext | undefined =>
  contextOf(connectionStore.settings, new Map([...stores].map(([slot, store]) => [slot, store.snapshot()])));

/** The mesh in view: the selected machine's; else the one picked last, else the first held, else the default identity. */
export function inViewSlot(): string {
  const picked = inView !== undefined && held.some((mesh) => mesh.slot === inView) ? inView : undefined;
  if (picked !== undefined && stores.get(picked)?.snapshot().phase === "removed") return picked;
  return selectedContext()?.slot ?? picked ?? held[0]?.slot ?? DEFAULT_SLOT;
}

/**
 * Every machine of every mesh is reachable at once, each tagged with its mesh and the slot whose keys that mesh knows:
 * a session to a machine of the second mesh must not offer the first mesh's key (#2861). A machine two meshes share is
 * dialled once, through the mesh that listed it first. A mesh that drops out of here takes its sessions with it.
 */
export function publish(): void {
  held = [...stores]
    .toSorted(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .flatMap(([slot, store]) => (store.snapshot().phase === "empty" ? [] : [{ slot, view: store.snapshot() }]));
  const machines: MemberTarget[] = [];
  for (const { slot, view } of held) {
    for (const machine of view.machines) {
      if (machines.some((known) => known.hostId === machine.hostId)) continue;
      machines.push({ ...machine, meshId: view.mesh, ...(slot === DEFAULT_SLOT ? {} : { keySlot: slot }) });
    }
  }
  connectionStore.setViewMembers(machines);
  notify();
}

export function useMembershipFailure(): string | undefined {
  return useSyncExternalStore(subscribe, () => restoreFailure);
}

export function setRestoreFailure(failure: string | undefined): void {
  restoreFailure = failure;
  notify();
}

export const membershipSnapshot = (): BundleView => stores.get(inViewSlot())?.snapshot() ?? EMPTY;
export const membershipBundle = (slot: string = inViewSlot()): MembershipStore | undefined => stores.get(slot);
export const loadedSlots = (): readonly string[] => [...stores.keys()];

/** The storage each loaded slot was read from (the page's IndexedDB, or a test's store). */
const sources = new Map<string, KeyValueStore>();

/**
 * Whether a loaded store is still who the slot's keys say. Its keys were read when it was loaded; another tab can have
 * replaced them since (the last mesh left there resets the default keys), and a store with the old ones would refuse
 * every roster that admits the new ones (review of #2890). Read from storage, not from what this page was told.
 */
export async function storeIsCurrent(store: MembershipStore, storage: KeyValueStore = deviceStore): Promise<boolean> {
  const now = await storedPublicHalves(slotKeys(storage, store.slot));
  return store.keys?.signPub === now.signPub && store.keys?.devicePub === now.devicePub;
}

/**
 * The store of one key slot, loaded with that slot's keys through `slotKeys`: a slot that holds no membership and no join
 * claim cannot get keys there, so a late caller (a refresh in flight after a leave) fails instead of reviving it. A store
 * loaded before is handed out again only while its keys are still the slot's stored keys; else it is loaded again.
 */
export async function prepareMembership(
  slot: string = DEFAULT_SLOT,
  storage: KeyValueStore = deviceStore,
): Promise<MembershipStore> {
  const pending = loading.get(slot);
  if (pending === undefined) return loadStore(slot, storage);
  const loaded = await pending;
  const current = loading.get(slot) === pending && (await storeIsCurrent(loaded, storage));
  // Re-read after every await: a concurrent caller may have dropped and reloaded the slot meanwhile, and this caller
  // then takes that newer load instead of dropping it again and returning a store the page does not hold (review of #2890).
  if (loading.get(slot) !== pending) return prepareMembership(slot, storage);
  if (current) return loaded;
  dropSlot(slot);
  return loadStore(slot, storage);
}

function loadStore(slot: string, storage: KeyValueStore): Promise<MembershipStore> {
  sources.set(slot, storage);
  const token = Symbol(slot);
  tokens.set(slot, token);
  const load = (async () => {
    const identity = await loadBrowserIdentity(slotKeys(storage, slot));
    const keys = {
      signPub: base64urlEncode(identity.card.publicKey),
      devicePub: base64urlEncode(identity.device.publicKey),
    };
    const store = new MembershipStore(storage, keys, slot);
    await store.load();
    if (tokens.get(slot) !== token) return store;
    stores.set(slot, store);
    if (!order.includes(slot)) order.push(slot);
    store.subscribe(publish);
    publish();
    return store;
  })();
  loading.set(slot, load);
  load.catch(() => loading.delete(slot));
  return load;
}

/** Drops one slot from this page: its store, its machines and their sessions, and any key loads this page holds for it. */
export function dropSlot(slot: string): void {
  stores.delete(slot);
  loading.delete(slot);
  tokens.delete(slot);
  if (order.includes(slot)) order.splice(order.indexOf(slot), 1);
  forgetCachedIdentity(slotKeys(sources.get(slot) ?? deviceStore, slot));
  sources.delete(slot);
  publish();
}

export function dropAll(): void {
  for (const slot of [...stores.keys(), ...loading.keys()]) {
    forgetCachedIdentity(slotKeys(sources.get(slot) ?? deviceStore, slot));
  }
  sources.clear();
  stores.clear();
  loading.clear();
  tokens.clear();
  order.length = 0;
  inView = undefined;
  publish();
}

export function useBrowserMembership(): BundleView {
  return useSyncExternalStore(subscribe, membershipSnapshot);
}

export function useHeldMeshes(): readonly HeldMesh[] {
  return useSyncExternalStore(subscribe, () => held);
}

export async function putInView(slot: string | undefined): Promise<void> {
  inView = slot;
  await deviceStore.put(IN_VIEW_KEY, slot ?? null);
  notify();
}

/** Puts a mesh in view and shows one of its machines (an online one first), so the selection and the mesh agree. */
export async function selectMembership(slot: string): Promise<void> {
  await putInView(slot);
  const mesh = stores.get(slot)?.snapshot().mesh;
  const machines = connectionStore.entries().filter((entry) => entry.target.meshId === mesh);
  const shown = machines.find((entry) => entry.state.phase === "open") ?? machines[0];
  if (shown !== undefined) connectionStore.select(shown.target.hostId);
}

/** Shows one machine; a machine of another mesh puts that mesh in view with it. */
export async function showMachine(hostId: string): Promise<void> {
  const target = connectionStore.entries().find((entry) => entry.target.hostId === hostId)?.target;
  connectionStore.select(hostId);
  if (target?.meshId !== undefined) await putInView(target.keySlot ?? DEFAULT_SLOT);
}
