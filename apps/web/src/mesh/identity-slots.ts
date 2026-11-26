import { memberCards } from "./bundle-view.ts";
import { resetBrowserIdentity } from "./identity.ts";
import {
  changeRecord,
  DEFAULT_SLOT,
  legacyMembership,
  type MeshRecord,
  type SlotClaim,
  storedRecord,
} from "./membership-list.ts";
import type { KeyValueStore } from "../storage/idb.ts";

export { DEFAULT_SLOT } from "./membership-list.ts";

/**
 * Where one browser identity keeps its keys (#2861). The default slot is the identity this browser always had: its keys
 * sit under their plain names, which pairing a device uses and every membership before #2861 rests on. Every further
 * mesh gets a slot of its own, so no key is shown to two meshes and one mesh cannot link this browser to another.
 */
const PREFIX = "mesh-identity/";
const KEY_MATERIAL = new Set(["device-key", "mesh-sign-key"]);
const SCRATCH = new Set(["device-key.probe", "mesh-sign-key.probe"]);

export class SlotNotEnrolled extends Error {
  override readonly name = "SlotNotEnrolled";
}

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
 * it, so the rule in `mayWrite` holds everywhere. One view per slot and store, because the key loaders remember a
 * pending creation per store object and a fresh view per call would let two first loads each create a key.
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
  held.set(slot, guarded);
  return guarded;
}

const taken = (record: MeshRecord, slot: string): boolean =>
  record.memberships.some((held) => held.keySlot === slot) || record.slots.some((claim) => claim.slot === slot);

/**
 * Claims a slot for one join before any key exists, under the mesh lock, so two joins at once (two tabs, an app and
 * its tab) never get the same identity. The first mesh takes the default identity, as a join always did; every other
 * join gets fresh keys. A slot name is random, so it says nothing about the mesh it will hold.
 */
export const claimSlot = (storage: KeyValueStore, owner: string): Promise<string> =>
  changeRecord(storage, (record) => {
    const slot = taken(record, DEFAULT_SLOT) ? crypto.randomUUID() : DEFAULT_SLOT;
    return { next: { ...record, slots: [...record.slots, { slot, phase: "enrolling", owner }] }, answer: slot };
  });

/** A resumed join keeps its claim; an anchor from an earlier release names the default slot, claimed again if free. */
export const resumeClaim = (storage: KeyValueStore, slot: string, owner: string): Promise<boolean> =>
  changeRecord(storage, (record) => {
    const others = record.slots.filter((claim) => claim.slot !== slot);
    const claim = { slot, phase: "enrolling", owner } as const;
    if (record.slots.some((held) => held.slot === slot && held.phase === "enrolling")) {
      return { next: { ...record, slots: [...others, claim] }, answer: true };
    }
    if (slot !== DEFAULT_SLOT || taken(record, slot)) return { next: record, answer: false };
    return { next: { ...record, slots: [...others, claim] }, answer: true };
  });

export type RetiringClaim = Extract<SlotClaim, { readonly phase: "retiring" }>;

/**
 * The first half of leaving a mesh or dropping a join, as one write under the lock: the membership goes and the slot is
 * marked retiring, with whether it was the last mesh decided in that same step. Undefined when there is nothing to
 * retire (another tab already did).
 */
export const beginRetire = (storage: KeyValueStore, slot: string): Promise<RetiringClaim | undefined> =>
  changeRecord(storage, (record) => {
    const held = record.memberships.find((membership) => membership.keySlot === slot);
    const claimed = record.slots.some((claim) => claim.slot === slot && claim.phase === "enrolling");
    if (held === undefined && !claimed) return { next: record, answer: undefined };
    const memberships = record.memberships.filter((membership) => membership !== held);
    const claim: RetiringClaim = {
      slot,
      phase: "retiring",
      joined: held !== undefined,
      hosts:
        held === undefined
          ? []
          : memberCards(held.records).flatMap((card) => (card.kind === "client" ? [] : [card.hostId])),
      last: held !== undefined && memberships.length === 0,
    };
    const slots = [...record.slots.filter((other) => other.slot !== slot), claim];
    return { next: { memberships, slots }, answer: claim };
  });

/**
 * The second half, safe to run again after a cut: both keys of the slot and their probes go, then the claim. A join
 * dropped on the default slot keeps its keys, which are also the pairing identity. `drop` clears what else names the
 * slot (a saved push route); it runs before the claim goes, so a cut there is finished on the next start too.
 */
export async function finishRetire(
  storage: KeyValueStore,
  claim: RetiringClaim,
  drop: (claim: RetiringClaim) => Promise<void>,
): Promise<void> {
  if (claim.joined || claim.slot !== DEFAULT_SLOT) await resetBrowserIdentity(slotKeys(storage, claim.slot));
  await drop(claim);
  await changeRecord(storage, (record) => ({
    next: { ...record, slots: record.slots.filter((other) => other.slot !== claim.slot) },
    answer: undefined,
  }));
}
