import type { Signed } from "@doriface/mesh";
import type { KeyValueStore } from "../storage/idb.ts";
import { DEFAULT_SLOT } from "../storage/key-slot.ts";

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

/** One membership as the list holds it: with the key slot (`storage/key-slot.ts`) whose keys the mesh knows. */
export interface HeldMembership extends BrowserMembership {
  readonly keySlot: string;
}

/**
 * Every mesh this browser is a member of, one entry per mesh (#2861). Before, the browser held one membership under
 * `mesh-membership`, so a second mesh could only replace the first; that entry moves into this list on first read.
 */
const LIST_KEY = "mesh-memberships";
const LEGACY_KEY = "mesh-membership";

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

/**
 * The list, moving the single entry of an earlier release into it. That entry rests on the keys this browser always
 * had, so it takes the default slot. It is moved whenever it is there, not only before the list exists: a tab still on
 * the earlier release can write it after this one wrote the list. It is cleared only once the list holds it; one that
 * does not parse, or whose default slot another mesh holds, is left where it is rather than deleted unread.
 *
 * Runs inside the mesh lock (`withMeshLock`): a migration racing a join could write the list back without the join.
 */
export async function readHeld(storage: KeyValueStore): Promise<readonly HeldMembership[]> {
  const saved: unknown = await storage.get(LIST_KEY);
  const list = Array.isArray(saved) ? saved.flatMap((entry) => heldOf(entry) ?? []) : [];
  const legacy = membershipOf(await storage.get(LEGACY_KEY));
  if (legacy === undefined) return list;
  if (list.some((held) => held.meshId === legacy.meshId)) {
    await storage.put(LEGACY_KEY, null);
    return list;
  }
  if (list.some((held) => held.keySlot === DEFAULT_SLOT)) return list;
  const moved = [{ ...legacy, keySlot: DEFAULT_SLOT }, ...list];
  await storage.put(LIST_KEY, moved);
  await storage.put(LEGACY_KEY, null);
  return moved;
}

export async function writeHeld(storage: KeyValueStore, next: HeldMembership): Promise<void> {
  const others = (await readHeld(storage)).filter((held) => held.keySlot !== next.keySlot);
  await storage.put(LIST_KEY, [...others, next]);
}

export async function removeHeld(storage: KeyValueStore, keySlot: string): Promise<void> {
  const others = (await readHeld(storage)).filter((held) => held.keySlot !== keySlot);
  await storage.put(LIST_KEY, others);
}

let chain: Promise<unknown> = Promise.resolve();

/**
 * Every change to the list runs one at a time: in this page through one chain (several slots' stores write the same
 * list), and across tabs through a Web Lock where there is one.
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

/** Every membership, for a reader outside a write: the read itself may migrate, so it takes the lock. */
export const memberships = (storage: KeyValueStore): Promise<readonly HeldMembership[]> =>
  withMeshLock(() => readHeld(storage));
