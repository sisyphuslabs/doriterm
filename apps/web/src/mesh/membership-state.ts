import { base64urlEncode } from "@doriface/crypto";
import { useSyncExternalStore } from "react";
import { hasBrowserIdentity, loadBrowserIdentity, resetBrowserIdentity } from "./identity.ts";
import { connectionStore } from "../connection/store.ts";
import { DEFAULT_SETTINGS, type MemberTarget } from "../connection/settings.ts";
import { deviceStore } from "../storage/idb.ts";
import { DEFAULT_SLOT, newSlot, slotStore } from "../storage/key-slot.ts";
import { MembershipStore } from "./membership.ts";
import { memberships } from "./membership-list.ts";
import { bundleView, type BundleView } from "./bundle-view.ts";

export interface HeldMesh {
  readonly slot: string;
  readonly view: BundleView;
}

const EMPTY = bundleView([], "", { signPub: "", devicePub: "" });
/** The slot of the mesh the person is looking at; kept so a reload shows the same mesh. */
const IN_VIEW_KEY = "mesh.in-view";
const listeners = new Set<() => void>();
const stores = new Map<string, MembershipStore>();
const loading = new Map<string, Promise<MembershipStore>>();
/** The order the slots were asked for, which is the list's order: loads finish in any order, the list does not move. */
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
const notify = (): void => {
  for (const listener of listeners) listener();
};

/** The mesh in view: the one picked, else the first held, else the default identity (a join in progress, or none). */
export function inViewSlot(): string {
  if (inView !== undefined && held.some((mesh) => mesh.slot === inView)) return inView;
  return held[0]?.slot ?? DEFAULT_SLOT;
}

/**
 * Every machine of every mesh is reachable at once, each tagged with its mesh and the slot whose keys that mesh knows:
 * a session to a machine of the second mesh must not offer the first mesh's key (#2861). A machine two meshes share is
 * dialled once, through the mesh that listed it first.
 */
function publish(): void {
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

export const membershipSnapshot = (): BundleView => stores.get(inViewSlot())?.snapshot() ?? EMPTY;
export const membershipBundle = (slot: string = inViewSlot()): MembershipStore | undefined => stores.get(slot);

/** The store of one key slot, loaded with that slot's keys; the default slot is the identity this browser always had. */
export function prepareMembership(slot: string = DEFAULT_SLOT): Promise<MembershipStore> {
  const pending = loading.get(slot);
  if (pending !== undefined) return pending;
  if (!order.includes(slot)) order.push(slot);
  const load = (async () => {
    const identity = await loadBrowserIdentity(slotStore(deviceStore, slot));
    const keys = {
      signPub: base64urlEncode(identity.card.publicKey),
      devicePub: base64urlEncode(identity.device.publicKey),
    };
    const store = new MembershipStore(deviceStore, keys, slot);
    await store.load();
    stores.set(slot, store);
    store.subscribe(publish);
    publish();
    return store;
  })();
  loading.set(slot, load);
  load.catch(() => loading.delete(slot));
  return load;
}

/**
 * The slot a new join runs on. The first mesh takes the default identity, as a join always did, so pairing and a single
 * mesh work as before; every further mesh gets fresh keys, never a key another mesh has seen.
 */
export async function joinSlot(): Promise<string> {
  const list = await memberships(deviceStore);
  return list.some((mesh) => mesh.keySlot === DEFAULT_SLOT) ? newSlot() : DEFAULT_SLOT;
}

/** A join that ended without a membership leaves no keys behind in its own slot: they were shown to that inviter only. */
export async function abandonJoin(slot: string): Promise<void> {
  if (slot === DEFAULT_SLOT || (await stores.get(slot)?.read()) !== undefined) return;
  stores.delete(slot);
  loading.delete(slot);
  await resetBrowserIdentity(slotStore(deviceStore, slot));
}

/** Empty storage is a stranger, not a failed connection and not an identity generated in the background. */
export async function restoreMembership(): Promise<void> {
  try {
    restoreFailure = undefined;
    await restoreHeld();
  } catch (error) {
    restoreFailure = error instanceof Error ? error.message : String(error);
  }
  notify();
}

/** A membership whose keys are gone is dropped alone; only when none is left does the browser start over (as before). */
async function restoreHeld(): Promise<void> {
  const list = await memberships(deviceStore);
  const first = list[0];
  if (first === undefined) return;
  const saved = await deviceStore.get(IN_VIEW_KEY);
  inView = typeof saved === "string" ? saved : undefined;
  const present = await Promise.all(list.map((mesh) => hasBrowserIdentity(slotStore(deviceStore, mesh.keySlot))));
  const kept = list.filter((_, index) => present[index] === true);
  await Promise.all(
    list
      .filter((_, index) => present[index] !== true)
      .map(async (mesh) => {
        await new MembershipStore(deviceStore, undefined, mesh.keySlot).forget();
        await resetBrowserIdentity(slotStore(deviceStore, mesh.keySlot));
      }),
  );
  const shown = kept.find((mesh) => mesh.keySlot === inView) ?? kept[0];
  if (shown === undefined) {
    connectionStore.update({ ...DEFAULT_SETTINGS, relayUrl: first.relayUrl });
    return;
  }
  connectionStore.edit({ relayUrl: shown.relayUrl });
  await Promise.all(kept.map((mesh) => prepareMembership(mesh.keySlot)));
}

export function useBrowserMembership(): BundleView {
  return useSyncExternalStore(subscribe, membershipSnapshot);
}

export function useHeldMeshes(): readonly HeldMesh[] {
  return useSyncExternalStore(subscribe, () => held);
}

async function putInView(slot: string): Promise<void> {
  inView = slot;
  await deviceStore.put(IN_VIEW_KEY, slot);
  notify();
}

/** Puts a mesh in view, and shows one of its machines (an online one first) so the workspace follows the pick. */
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

/**
 * Forgets one mesh and that mesh's keys. The others stay as they were, with their connections; only the last one leaving
 * returns the browser to a stranger, which also ends any join in progress and clears the saved machines as before.
 */
export async function forgetMembership(slot: string = inViewSlot()): Promise<void> {
  const others = (await memberships(deviceStore)).filter((mesh) => mesh.keySlot !== slot);
  const store = stores.get(slot) ?? new MembershipStore(deviceStore, undefined, slot);
  if (others.length > 0) {
    await store.forget();
    stores.delete(slot);
    loading.delete(slot);
    order.splice(order.indexOf(slot), 1);
    await resetBrowserIdentity(slotStore(deviceStore, slot));
    publish();
    return;
  }
  connectionStore.stop();
  await store.forget();
  await deviceStore.put("mesh.join-anchor", null);
  await deviceStore.put(IN_VIEW_KEY, null);
  await resetBrowserIdentity(slotStore(deviceStore, slot));
  if (slot !== DEFAULT_SLOT) await resetBrowserIdentity();
  stores.clear();
  loading.clear();
  order.length = 0;
  inView = undefined;
  connectionStore.update({ ...DEFAULT_SETTINGS, relayUrl: connectionStore.settings.relayUrl });
  publish();
}
