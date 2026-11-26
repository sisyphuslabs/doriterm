import { JoinRefused } from "@doriface/mesh/join";
import { DEFAULT_SETTINGS } from "../connection/settings.ts";
import { connectionStore } from "../connection/store.ts";
import { JOIN_ANCHOR_KEY } from "../pair/join-anchor.ts";
import { loadPushRoute, savePushRoute } from "../push/push-route.ts";
import { deviceStore, type KeyValueStore } from "../storage/idb.ts";
import { hasBrowserIdentity, resetBrowserIdentity } from "./identity.ts";
import {
  beginRetire,
  claimSlot,
  DEFAULT_SLOT,
  finishRetire,
  resumeClaim,
  type RetiringClaim,
  slotKeys,
} from "./identity-slots.ts";
import { currentRecord } from "./membership-list.ts";
import * as view from "./membership-state.ts";

/**
 * Every tab of this browser hears when the record changes, so a mesh left in one tab drops its machines, sessions and
 * cached keys in all of them (review of #2890). The service worker holds nothing between pushes: it reads the saved
 * route, which a leave clears, and loads keys through `slotKeys`, which refuses a retired slot.
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
  for (const slot of view.loadedSlots()) if (!kept.has(slot)) view.dropSlot(slot);
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

/** The last mesh gone: the browser is a stranger again, as before #2861 (no join in progress, no saved machines). */
async function strangerAgain(storage: KeyValueStore, claim: RetiringClaim): Promise<void> {
  connectionStore.stop();
  await storage.put(JOIN_ANCHOR_KEY, null);
  await storage.put(view.IN_VIEW_KEY, null);
  if (claim.slot !== DEFAULT_SLOT) await resetBrowserIdentity(slotKeys(storage, DEFAULT_SLOT));
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

async function retire(slot: string, storage: KeyValueStore = deviceStore): Promise<void> {
  const claim = await beginRetire(storage, slot);
  view.dropSlot(slot);
  announce();
  if (claim !== undefined) await finishRetire(storage, claim, afterKeys(storage));
  announce();
}

/** Forgets one mesh: its membership, both of its keys and their probes, and what names it; the others stay. */
export const forgetMembership = (
  slot: string = view.inViewSlot(),
  storage: KeyValueStore = deviceStore,
): Promise<void> => retire(slot, storage);

/** A join that ended without a membership leaves no keys in its own slot: they were shown to that inviter only. */
export async function abandonJoin(slot: string, storage: KeyValueStore = deviceStore): Promise<void> {
  const record = await currentRecord(storage);
  if (record.memberships.some((held) => held.keySlot === slot)) return;
  await retire(slot, storage);
}

/** Holds a Web Lock until the returned function is called; without Web Locks there is no other tab to tell apart. */
function holdLock(name: string): Promise<() => void> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (locks === undefined) return Promise.resolve(() => undefined);
  return new Promise((acquired) => {
    void locks.request(name, () => new Promise<void>((release) => acquired(release)));
  });
}

const enrollLock = (owner: string): string => `doriface-enroll/${owner}`;

/**
 * The slot one join runs on, claimed before any key exists and held for the join's life: the owner's lock is taken
 * first, so there is no moment when the claim exists and a sweep in another tab could take it for an abandoned one.
 */
export async function beginJoin(resumeSlot?: string): Promise<{ readonly slot: string; readonly end: () => void }> {
  const owner = crypto.randomUUID();
  const end = await holdLock(enrollLock(owner));
  try {
    if (resumeSlot === undefined) return { slot: await claimSlot(deviceStore, owner), end };
    if (await resumeClaim(deviceStore, resumeSlot, owner)) return { slot: resumeSlot, end };
    throw new JoinRefused("Ask for a new invite");
  } catch (error) {
    end();
    throw error;
  }
}

async function liveJoin(owner: string): Promise<boolean> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (locks === undefined) return true;
  const { held = [] } = await locks.query();
  return held.some((lock) => lock.name === enrollLock(owner));
}

function anchoredSlot(anchor: unknown): string | undefined {
  if (typeof anchor !== "object" || anchor === null) return undefined;
  const slot: unknown = Reflect.get(anchor, "keySlot");
  return typeof slot === "string" ? slot : DEFAULT_SLOT;
}

/**
 * Finishes what an earlier page left: a leave cut short is completed, and a join claim no tab is running and the saved
 * join does not name is dropped with its keys (review of #2890).
 */
export async function sweep(storage: KeyValueStore = deviceStore, live = liveJoin): Promise<void> {
  const record = await currentRecord(storage);
  const anchored = anchoredSlot(await storage.get(JOIN_ANCHOR_KEY));
  await Promise.all(
    record.slots.map(async (claim) => {
      if (claim.phase === "retiring") return finishRetire(storage, claim, afterKeys(storage));
      if (claim.slot !== anchored && !(await live(claim.owner))) return retire(claim.slot, storage);
      return undefined;
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
  await Promise.all(memberships.filter((_, index) => present[index] !== true).map((held) => retire(held.keySlot)));
  const kept = memberships.filter((_, index) => present[index] === true);
  const saved = await deviceStore.get(view.IN_VIEW_KEY);
  const shown = kept.find((held) => held.keySlot === saved) ?? kept[0];
  if (shown === undefined) return;
  connectionStore.edit({ relayUrl: shown.relayUrl });
  await Promise.all(kept.map((held) => view.prepareMembership(held.keySlot)));
  if (typeof saved === "string" && kept.some((held) => held.keySlot === saved)) await view.selectMembership(saved);
}
