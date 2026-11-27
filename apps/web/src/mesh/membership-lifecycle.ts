import { DEFAULT_SETTINGS } from "../connection/settings.ts";
import { connectionStore } from "../connection/store.ts";
import { JOIN_ANCHOR_KEY } from "../pair/join-anchor.ts";
import { loadPushRoute, savePushRoute } from "../push/push-route.ts";
import { deviceStore, type KeyValueStore } from "../storage/idb.ts";
import { hasBrowserIdentity, resetBrowserIdentity } from "./identity.ts";
import { beginRetire, finishRetire, type RetireTarget, type RetiringClaim } from "./enrollment.ts";
import { DEFAULT_SLOT, slotKeys } from "./identity-slots.ts";
import { liveJoin } from "./join-locks.ts";
import { currentRecord, readRecord } from "./mesh-record.ts";
import { withMeshLock } from "./membership-list.ts";
import * as view from "./membership-state.ts";

/**
 * Every tab of this browser hears when the record changes, so a mesh left in one tab drops its machines, sessions and
 * cached keys in all of them (review of #2890). This is clean-up only, never what authorizes a key: a context it does not
 * reach (the service worker keeps its own key cache for its life) is held by `slot-authority.ts`, which refuses every
 * use of a key that is not the slot's stored and recorded key now, and by the leave clearing the saved push route.
 */
const meshBus = typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel("doriface-mesh");
/** A BroadcastChannel is a message port with no target origin, typed by the one method used, as `vault-channel.ts` does. */
interface Port {
  postMessage(message: unknown): void;
}
const tell = (port: Port | undefined): void => port?.postMessage({ type: "memberships-changed" });
const announce = (): void => tell(meshBus);
meshBus?.addEventListener("message", () => void reconcile().catch(view.setRestoreFailure));

/** Brings this page in line with the record: slots that hold no mesh go, meshes another tab joined come in. */
export async function reconcile(): Promise<void> {
  const record = await currentRecord(deviceStore);
  const kept = new Set([
    ...record.memberships.map((held) => held.keySlot),
    ...record.slots.flatMap((claim) => (claim.phase === "enrolling" ? [claim.slot] : [])),
  ]);
  // A store that never held a mesh is kept with its roster refresh's bound, but only while its keys are still the slot's:
  // another tab's last leave resets the default keys, and a store with the old ones would refuse every roster.
  await Promise.all(
    view.loadedSlots().map(async (slot) => {
      if (kept.has(slot)) return;
      const store = view.membershipBundle(slot);
      const keep = store?.snapshot().phase === "empty" && (await view.storeIsCurrent(store));
      if (!keep) view.dropSlot(slot);
    }),
  );
  await Promise.all(record.memberships.map((held) => view.prepareMembership(held.keySlot)));
}

/** A saved push route that reached the retired mesh is cleared: the worker would otherwise dial with a deleted key. */
async function dropRoute(storage: KeyValueStore, claim: RetiringClaim): Promise<void> {
  const route = await loadPushRoute(storage);
  if (route?.mode !== "relay") return;
  const ours =
    route.keySlot === undefined
      ? claim.slot === DEFAULT_SLOT && claim.hosts.includes(route.hostId)
      : route.keySlot === claim.slot;
  if (ours) await savePushRoute(null, storage);
}

/**
 * The last mesh gone: the browser is a stranger again, as before #2861 (no join in progress, no saved machines). Checked
 * again under the mesh lock when it runs, which may be a later start finishing a cut leave: a join that claimed a slot
 * since (another tab) keeps its keys and its saved join, and nothing is reset (review of #2890, LOW-5). `claimSlot` takes
 * the same lock, so no claim can land between the check and the reset.
 */
async function strangerAgain(storage: KeyValueStore, claim: RetiringClaim): Promise<void> {
  const reset = await withMeshLock(async () => {
    const record = await readRecord(storage);
    if (record.memberships.length > 0 || record.slots.some((other) => other.phase === "enrolling")) return false;
    await storage.put(JOIN_ANCHOR_KEY, null);
    await storage.put(view.IN_VIEW_KEY, null);
    if (claim.slot !== DEFAULT_SLOT) await resetBrowserIdentity(slotKeys(storage, DEFAULT_SLOT));
    return true;
  });
  if (!reset) return;
  connectionStore.stop();
  view.dropAll();
  connectionStore.update({ ...DEFAULT_SETTINGS, relayUrl: connectionStore.settings.relayUrl });
}

/** Everything else a retiring slot needs gone, before its claim is: so a cut anywhere is finished on the next start. */
const afterKeys =
  (storage: KeyValueStore) =>
  async (claim: RetiringClaim): Promise<void> => {
    await dropRoute(storage, claim);
    if (claim.last) await strangerAgain(storage, claim);
  };

/**
 * Whether retiring drops the slot's store from this page. A join dropped on the default slot before it held a mesh (a
 * roster refresh of a paired machine that offered none) keeps its keys, which are the pairing identity, and its empty
 * store: that store carries the per-machine refresh bound (`claimRefresh`), and a fresh store each time would refresh,
 * abandon and republish on every new session of a paired machine, restarting it in a loop (relay e2e on #2890).
 */
export const dropsStore = (slot: string, claim: RetiringClaim | undefined): boolean =>
  claim === undefined || claim.joined || slot !== DEFAULT_SLOT;

/** Retires one lifecycle of a slot (`RetireTarget`) and drops it from every tab; see `beginRetire`/`finishRetire`. */
export async function retireSlot(
  slot: string,
  storage: KeyValueStore = deviceStore,
  target: RetireTarget = {},
): Promise<void> {
  const claim = await beginRetire(storage, slot, target);
  if (dropsStore(slot, claim)) view.dropSlot(slot);
  announce();
  if (claim !== undefined) await finishRetire(storage, claim, afterKeys(storage));
  announce();
}

/** Forgets one mesh: its membership, both of its keys and their probes, and what names it; the others stay. */
export const forgetMembership = (
  slot: string = view.inViewSlot(),
  storage: KeyValueStore = deviceStore,
): Promise<void> => retireSlot(slot, storage);

/** The join the saved anchor names, slot and generation, or undefined when there is none or it names no generation. */
function anchoredJoin(anchor: unknown): { readonly slot: string; readonly generation: number } | undefined {
  if (typeof anchor !== "object" || anchor === null) return undefined;
  const slot: unknown = Reflect.get(anchor, "keySlot");
  const generation: unknown = Reflect.get(anchor, "generation");
  if (typeof generation !== "number") return undefined;
  return { slot: typeof slot === "string" ? slot : DEFAULT_SLOT, generation };
}

/**
 * Finishes what an earlier page left: a leave cut short is completed, and a join claim no tab is running and the saved
 * join does not name is dropped with its keys (review of #2890).
 */
export async function sweep(storage: KeyValueStore = deviceStore, live = liveJoin): Promise<void> {
  const record = await currentRecord(storage);
  const anchored = anchoredJoin(await storage.get(JOIN_ANCHOR_KEY));
  await Promise.all(
    record.slots.map(async (claim) => {
      if (claim.phase === "retiring") return finishRetire(storage, claim, afterKeys(storage));
      const saved = anchored?.slot === claim.slot && anchored.generation === claim.generation;
      if (saved || (await live(claim.owner))) return undefined;
      return retireSlot(claim.slot, storage, { generation: claim.generation, claimOnly: true });
    }),
  );
}

/** Empty storage is a stranger, not a failed connection and not an identity generated in the background. */
export async function restoreMembership(): Promise<void> {
  try {
    view.setRestoreFailure(undefined);
    await sweep();
    await restoreHeld();
  } catch (error) {
    view.setRestoreFailure(error instanceof Error ? error.message : String(error));
  }
}

/** A membership whose keys are gone is retired alone; when none is left the browser is a stranger again. */
async function restoreHeld(): Promise<void> {
  const { memberships } = await currentRecord(deviceStore);
  const present = await Promise.all(memberships.map((held) => hasBrowserIdentity(slotKeys(deviceStore, held.keySlot))));
  await Promise.all(
    memberships
      .filter((_, index) => present[index] !== true)
      .map((held) => retireSlot(held.keySlot, deviceStore, { generation: held.generation })),
  );
  const kept = memberships.filter((_, index) => present[index] === true);
  const saved = await deviceStore.get(view.IN_VIEW_KEY);
  const shown = kept.find((held) => held.keySlot === saved) ?? kept[0];
  if (shown === undefined) return;
  connectionStore.edit({ relayUrl: shown.relayUrl });
  await Promise.all(kept.map((held) => view.prepareMembership(held.keySlot)));
  if (typeof saved === "string" && kept.some((held) => held.keySlot === saved)) await view.selectMembership(saved);
}
