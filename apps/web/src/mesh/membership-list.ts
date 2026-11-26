import type { Signed } from "@doriface/mesh";
import type { KeyValueStore } from "../storage/idb.ts";
import { BundleRefused, merge } from "./bundle-merge.ts";

/** The identity this browser always had: its keys sit under their plain names, as pairing a device uses them. */
export const DEFAULT_SLOT = "";

/**
 * What this browser keeps once it is a member: the verified bundle its membership rests on, and how it is named in
 * it. The member list is `membersOf(records)`, the same view every member computes, and this browser is the entry
 * whose signing key is `signPub`: nothing in the record says "the one looking" (design of #956 §2, Q on #1386).
 */
export interface BrowserMembership {
  readonly meshId: string;
  /** The welcome as checked at the join, and every verified record learned since; never shrunk by a later answer. */
  readonly records: readonly Signed[];
  /** This browser's Ed25519 signing key, base64url: its identity on every member, and the subject a revoke names. */
  readonly signPub: string;
  /** The member the join ran through, kept for the record; it holds no authority over the bundle. */
  readonly inviter: { readonly hostId: string; readonly hostKey: string };
  readonly relayUrl: string;
  readonly joinedAt: string;
}

/** One membership as the record holds it: with the key slot (`identity-slots.ts`) whose keys the mesh knows. */
export interface HeldMembership extends BrowserMembership {
  readonly keySlot: string;
}

/**
 * A key slot that holds no membership yet or any more. `enrolling`: a join claimed it before any key existed, so two
 * joins never share keys; `owner` names the Web Lock that join holds while it runs, so a sweep can tell a live join in
 * another tab from one whose tab is gone. `retiring`: its mesh was left and its keys are being deleted; `hosts` are that mesh's machines
 * and `last` says whether it was the last mesh, so cleanup cut short is finished on the next start.
 */
export type SlotClaim =
  | { readonly slot: string; readonly phase: "enrolling"; readonly owner: string }
  | {
      readonly slot: string;
      readonly phase: "retiring";
      /** False for a join dropped before it held a mesh. */
      readonly joined: boolean;
      readonly hosts: readonly string[];
      readonly last: boolean;
    };

/**
 * Every mesh this browser is in and every claimed slot, in ONE stored value (#2861): each change is a single put, so a
 * write cut short leaves the value before or after it, never a membership without its slot or the other way round.
 */
export interface MeshRecord {
  readonly memberships: readonly HeldMembership[];
  readonly slots: readonly SlotClaim[];
}

const RECORD_KEY = "mesh-memberships";
/** Where the single membership of an earlier release lives, and a tab still on it writes. */
const LEGACY_KEY = "mesh-membership";
const EMPTY: MeshRecord = { memberships: [], slots: [] };

const text = (value: object, key: string): string | undefined => {
  const raw: unknown = Reflect.get(value, key);
  return typeof raw === "string" ? raw : undefined;
};

const isSigned = (value: unknown): value is Signed =>
  typeof value === "object" && value !== null && text(value, "body") !== undefined && text(value, "sig") !== undefined;

/** A malformed value reads as no membership rather than a broken one. */
export function membershipOf(value: unknown): BrowserMembership | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const records: unknown = Reflect.get(value, "records");
  const inviter: unknown = Reflect.get(value, "inviter");
  if (!Array.isArray(records) || !records.every(isSigned) || typeof inviter !== "object" || inviter === null) {
    return undefined;
  }
  const [meshId, signPub, relayUrl, joinedAt] = ["meshId", "signPub", "relayUrl", "joinedAt"].map((k) =>
    text(value, k),
  );
  const [hostId, hostKey] = [text(inviter, "hostId"), text(inviter, "hostKey")];
  if ([meshId, signPub, relayUrl, joinedAt, hostId, hostKey].some((field) => field === undefined)) return undefined;
  return {
    meshId: meshId ?? "",
    records,
    signPub: signPub ?? "",
    inviter: { hostId: hostId ?? "", hostKey: hostKey ?? "" },
    relayUrl: relayUrl ?? "",
    joinedAt: joinedAt ?? "",
  };
}

function heldOf(value: unknown): HeldMembership | undefined {
  const membership = membershipOf(value);
  const keySlot = typeof value === "object" && value !== null ? text(value, "keySlot") : undefined;
  return membership === undefined || keySlot === undefined ? undefined : { ...membership, keySlot };
}

function claimOf(value: unknown): SlotClaim | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const slot = text(value, "slot");
  const phase = text(value, "phase");
  if (slot === undefined) return undefined;
  const owner = text(value, "owner");
  if (phase === "enrolling") return owner === undefined ? undefined : { slot, phase, owner };
  const hosts: unknown = Reflect.get(value, "hosts");
  const last: unknown = Reflect.get(value, "last");
  const joined: unknown = Reflect.get(value, "joined");
  if (phase !== "retiring" || !Array.isArray(hosts) || typeof last !== "boolean" || typeof joined !== "boolean") {
    return undefined;
  }
  return { slot, phase, joined, hosts: hosts.filter((host) => typeof host === "string"), last };
}

/** The stored record as it is, without the earlier release's entry: what a reader that must not write may see. */
export async function storedRecord(storage: KeyValueStore): Promise<MeshRecord> {
  const saved: unknown = await storage.get(RECORD_KEY);
  if (typeof saved !== "object" || saved === null) return EMPTY;
  const memberships: unknown = Reflect.get(saved, "memberships");
  const slots: unknown = Reflect.get(saved, "slots");
  return {
    memberships: Array.isArray(memberships) ? memberships.flatMap((entry) => heldOf(entry) ?? []) : [],
    slots: Array.isArray(slots) ? slots.flatMap((entry) => claimOf(entry) ?? []) : [],
  };
}

export const legacyMembership = async (storage: KeyValueStore): Promise<BrowserMembership | undefined> =>
  membershipOf(await storage.get(LEGACY_KEY));

export const writeRecord = (storage: KeyValueStore, record: MeshRecord): Promise<void> =>
  storage.put(RECORD_KEY, { version: 1, memberships: record.memberships, slots: record.slots });

/**
 * The record, with the earlier release's single entry taken in. That entry rests on the keys this browser always had,
 * so it takes the default slot. It is taken in whenever it is there, not only before the record exists: a tab still on
 * the earlier release can write it later. When the record already holds that mesh, the two verified histories are
 * merged (a revoke learned by the old tab is kept). The old entry is cleared only after the record holding it is
 * written, so a write cut short in between is taken in again, idempotently. An entry that does not parse, whose records
 * the door refuses, or whose default slot another mesh holds stays where it is: nothing is deleted that is not kept.
 *
 * Runs inside the mesh lock (`withMeshLock`): a migration racing a join could write the record back without the join.
 */
export async function readRecord(storage: KeyValueStore): Promise<MeshRecord> {
  const record = await storedRecord(storage);
  const legacy = membershipOf(await storage.get(LEGACY_KEY));
  if (legacy === undefined) return record;
  const same = record.memberships.find((held) => held.meshId === legacy.meshId);
  let memberships: readonly HeldMembership[];
  if (same !== undefined) {
    let records: readonly Signed[];
    try {
      records = merge(same.records, legacy.records);
    } catch (error) {
      if (error instanceof BundleRefused) return record;
      throw error;
    }
    memberships = record.memberships.map((held) => (held === same ? { ...held, records } : held));
  } else if (record.memberships.some((held) => held.keySlot === DEFAULT_SLOT)) {
    return record;
  } else {
    memberships = [{ ...legacy, keySlot: DEFAULT_SLOT }, ...record.memberships];
  }
  const taken = { ...record, memberships };
  await writeRecord(storage, taken);
  await storage.put(LEGACY_KEY, null);
  return taken;
}

let chain: Promise<unknown> = Promise.resolve();

/**
 * Every change to the record runs one at a time: in this page through one chain (several slots' stores write the same
 * record), and across tabs and the earlier release's tabs through the Web Lock that release took for its own writes.
 */
export function withMeshLock<T>(action: () => Promise<T>): Promise<T> {
  const locked = async (): Promise<T> => {
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    return locks === undefined ? action() : locks.request("doriface-mesh-bundle", action);
  };
  const result = chain.then(locked, locked);
  chain = result;
  return result;
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
  (await withMeshLock(() => readRecord(storage))).memberships;
