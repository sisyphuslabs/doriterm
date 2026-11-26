import { base64urlEncode } from "@doriface/crypto";
import type { Signed } from "@doriface/mesh";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { KeyValueStore } from "../storage/idb.ts";
import { BundleRefused, merge } from "./bundle-merge.ts";
import {
  type BrowserMembership,
  DEFAULT_SLOT,
  type HeldMembership,
  LEGACY_KEY,
  type MeshRecord,
  membershipOf,
  storedRecord,
  withMeshLock,
  writeRecord,
} from "./membership-list.ts";

export const legacyMembership = async (storage: KeyValueStore): Promise<BrowserMembership | undefined> =>
  membershipOf(await storage.get(LEGACY_KEY));

/** The public half of the default identity's stored signing key, in every form a release has stored it. */
async function defaultSignPub(storage: KeyValueStore): Promise<string | undefined> {
  const held: unknown = await storage.get("mesh-sign-key");
  if (typeof held !== "object" || held === null) return undefined;
  const publicKey: unknown = Reflect.get(held, "publicKey");
  if (publicKey instanceof Uint8Array) return base64urlEncode(publicKey);
  const secret: unknown = Reflect.get(held, Reflect.get(held, "kind") === "ed25519" ? "secretKey" : "privateKey");
  return secret instanceof Uint8Array && secret.length === 32
    ? base64urlEncode(ed25519.getPublicKey(secret))
    : undefined;
}

/** The legacy entry merged into the record, or undefined when it cannot be reconciled now and must stay where it is. */
async function reconcile(
  storage: KeyValueStore,
  record: MeshRecord,
  legacy: BrowserMembership,
): Promise<MeshRecord | undefined> {
  const same = record.memberships.find((held) => held.meshId === legacy.meshId);
  if (same !== undefined) {
    // The same mesh under another identity is not this browser's history to merge.
    if (same.signPub !== legacy.signPub) return undefined;
    let records: readonly Signed[];
    try {
      records = merge(same.records, legacy.records);
    } catch (error) {
      if (error instanceof BundleRefused) return undefined;
      throw error;
    }
    const memberships = record.memberships.map((held) => (held === same ? { ...held, records } : held));
    return { ...record, memberships };
  }
  // The default slot is someone's while a mesh, a join or a leave holds it: the old entry waits until it is free.
  const busy =
    record.memberships.some((held) => held.keySlot === DEFAULT_SLOT) ||
    record.slots.some((claim) => claim.slot === DEFAULT_SLOT);
  if (busy || (await defaultSignPub(storage)) !== legacy.signPub) return undefined;
  const taken: HeldMembership = { ...legacy, keySlot: DEFAULT_SLOT, generation: record.next };
  return { ...record, memberships: [taken, ...record.memberships], next: record.next + 1 };
}

/**
 * The record, with the earlier release's single entry taken in. That entry rests on the keys this browser always had, so
 * it takes the default slot, and only when those keys are still the ones it names and no join or leave holds that slot
 * (review of #2890). It is taken in whenever it is there, not only before the record exists: a tab still on the earlier
 * release can write it later. The same mesh's verified histories are merged (a revoke learned by the old tab is kept).
 * The old entry is cleared only after the record holding it is written, so a write cut short is taken in again; one that
 * cannot be reconciled stays where it is, so nothing valid is dropped.
 *
 * Runs inside the mesh lock (`withMeshLock`): a migration racing a join could write the record back without the join.
 */
export async function readRecord(storage: KeyValueStore): Promise<MeshRecord> {
  const record = await storedRecord(storage);
  const legacy = await legacyMembership(storage);
  if (legacy === undefined) return record;
  const taken = await reconcile(storage, record, legacy);
  if (taken === undefined) return record;
  await writeRecord(storage, taken);
  await storage.put(LEGACY_KEY, null);
  return taken;
}

/** Reads and rewrites the record in one locked step; `change` returns the next record and an answer for the caller. */
export function changeRecord<T>(
  storage: KeyValueStore,
  change: (record: MeshRecord) => { readonly next: MeshRecord; readonly answer: T },
): Promise<T> {
  return withMeshLock(async () => {
    const { next, answer } = change(await readRecord(storage));
    await writeRecord(storage, next);
    return answer;
  });
}

/** The whole record for a reader outside a write, with the old entry taken in. */
export const currentRecord = (storage: KeyValueStore): Promise<MeshRecord> => withMeshLock(() => readRecord(storage));

/** Every membership, for a reader outside a write: the read itself may take in the old entry, so it takes the lock. */
export const memberships = async (storage: KeyValueStore): Promise<readonly HeldMembership[]> =>
  (await currentRecord(storage)).memberships;
