import type { KeyValueStore } from "../storage/idb.ts";
import { governKeys } from "../storage/key-authority.ts";
import { legacyMembership } from "./mesh-record.ts";
import { DEFAULT_SLOT, storedRecord } from "./membership-list.ts";
import { SlotNotEnrolled, slotAuthority } from "./slot-authority.ts";

export { DEFAULT_SLOT } from "./membership-list.ts";
export { SlotNotEnrolled } from "./slot-authority.ts";

/**
 * Where one browser identity keeps its keys (#2861). The default slot is the identity this browser always had: its keys
 * sit under their plain names, which pairing a device uses and every membership before #2861 rests on. Every further
 * mesh gets a slot of its own, so no key is shown to two meshes and one mesh cannot link this browser to another.
 */
const PREFIX = "mesh-identity/";
const KEY_MATERIAL = new Set(["device-key", "mesh-sign-key"]);
const SCRATCH = new Set(["device-key.probe", "mesh-sign-key.probe"]);

type Standing = "member" | "enrolling" | "retiring" | "none";

async function standingOf(storage: KeyValueStore, slot: string): Promise<Standing> {
  const record = await storedRecord(storage);
  if (record.memberships.some((held) => held.keySlot === slot)) return "member";
  if (slot === DEFAULT_SLOT && (await legacyMembership(storage)) !== undefined) return "member";
  return record.slots.find((claim) => claim.slot === slot)?.phase ?? "none";
}

/**
 * Whether key material may be written into a slot. Only a join that claimed the slot creates keys. An enrolled identity
 * is read-only: its keys may be stored again as they are (a raw key moved into a CryptoKey) but never replaced, so a dial
 * that finds them gone fails instead of showing the mesh a new key. A slot being retired takes nothing, so a load in
 * flight cannot bring a forgotten identity back. The default slot with no mesh is the pairing identity, created on use.
 */
async function mayWrite(storage: KeyValueStore, slot: string, key: string, keys: KeyValueStore): Promise<boolean> {
  const standing = await standingOf(storage, slot);
  if (standing === "enrolling") return true;
  if (standing === "retiring") return false;
  if (SCRATCH.has(key)) return standing === "member" || slot === DEFAULT_SLOT;
  if (standing === "member") return (await keys.get(key)) != null;
  return slot === DEFAULT_SLOT;
}

const views = new WeakMap<KeyValueStore, Map<string, KeyValueStore>>();

function rawSlot(storage: KeyValueStore, slot: string): KeyValueStore {
  if (slot === DEFAULT_SLOT) return storage;
  return {
    get: (key) => storage.get(`${PREFIX}${slot}/${key}`),
    put: (key, value) => storage.put(`${PREFIX}${slot}/${key}`, value),
  };
}

/**
 * The one way to a slot's keys: every loader (dial, push, roster, join, the service worker) reads and writes through
 * it, so the write rule in `mayWrite` holds everywhere, and every key it loads is checked on each use by the slot's live
 * authority (`slot-authority.ts`). One view per slot and store, because the key loaders remember a pending creation per
 * store object and a fresh view per call would let two first loads each create a key.
 */
export function slotKeys(storage: KeyValueStore, slot: string): KeyValueStore {
  const held = views.get(storage) ?? new Map<string, KeyValueStore>();
  views.set(storage, held);
  const known = held.get(slot);
  if (known !== undefined) return known;
  const keys = rawSlot(storage, slot);
  const guarded: KeyValueStore = {
    get: (key) => keys.get(key),
    put: async (key, value) => {
      const material = KEY_MATERIAL.has(key) || SCRATCH.has(key);
      if (value != null && material && !(await mayWrite(storage, slot, key, keys))) {
        throw new SlotNotEnrolled("This mesh identity is not enrolled on this browser.");
      }
      await keys.put(key, value);
    },
  };
  governKeys(guarded, () => slotAuthority(storage, keys, slot));
  held.set(slot, guarded);
  return guarded;
}
