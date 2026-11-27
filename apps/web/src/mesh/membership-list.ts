import type { Signed } from "@doriface/mesh";
import type { KeyValueStore } from "../storage/idb.ts";

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
  /** The enrollment it came from (see `Enrollment`); a key loaded for another generation may not act for it. */
  readonly generation: number;
  /** The public half of the Noise key recorded for this generation (`slot-authority.ts`); `signPub` is the signing one. */
  readonly devicePub?: string;
}

/**
 * One enrollment: the slot it runs on, the one owner allowed to commit it (the Web Lock its join holds), and its lifecycle
 * generation. A generation is handed out once and never again, so a commit, a resumed join or a delayed cleanup that
 * names an older generation can be told apart from the identity that holds the slot now (review of #2890).
 */
export interface Enrollment {
  readonly slot: string;
  readonly owner: string;
  readonly generation: number;
}

/**
 * A key slot that holds no membership yet or any more. `enrolling`: a join claimed it before any key existed, so two
 * joins never share keys; `owner` names the Web Lock that join holds while it runs, so a sweep can tell a live join in
 * another tab from one whose tab is gone. `retiring`: its mesh was left and its keys are being deleted; `hosts` are that mesh's machines
 * and `last` says whether it was the last mesh, so cleanup cut short is finished on the next start.
 */
export type SlotClaim =
  | (Enrollment & {
      readonly phase: "enrolling";
      /** The public halves of the keys this join loaded, recorded on its first load so no other key can follow. */
      readonly signPub?: string;
      readonly devicePub?: string;
    })
  | {
      readonly slot: string;
      readonly phase: "retiring";
      /** The generation being retired: cleanup acts only while the slot is still at it. */
      readonly generation: number;
      /** False for a join dropped before it held a mesh. */
      readonly joined: boolean;
      readonly hosts: readonly string[];
      readonly last: boolean;
    };

/**
 * Every mesh this browser is in and every claimed slot, in ONE stored value (#2861): each change is a single put, so a
 * write cut short leaves the value before or after it, never a membership without its slot or the other way round.
 */
export type EnrollingClaim = Extract<SlotClaim, { readonly phase: "enrolling" }>;

export interface MeshRecord {
  readonly memberships: readonly HeldMembership[];
  readonly slots: readonly SlotClaim[];
  /** The next generation to hand out. */
  readonly next: number;
}

const RECORD_KEY = "mesh-memberships";
/** Where the single membership of an earlier release lives, and a tab still on it writes. */
export const LEGACY_KEY = "mesh-membership";
const EMPTY: MeshRecord = { memberships: [], slots: [], next: 1 };

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

const count = (value: object, key: string): number | undefined => {
  const raw: unknown = Reflect.get(value, key);
  return typeof raw === "number" && Number.isSafeInteger(raw) ? raw : undefined;
};

function heldOf(value: unknown): HeldMembership | undefined {
  const membership = membershipOf(value);
  if (membership === undefined || typeof value !== "object" || value === null) return undefined;
  const keySlot = text(value, "keySlot");
  // A record written before generations existed is generation 0: kept, never dropped for lacking the field.
  if (keySlot === undefined) return undefined;
  const devicePub = text(value, "devicePub");
  const generation = count(value, "generation") ?? 0;
  return { ...membership, keySlot, generation, ...(devicePub === undefined ? {} : { devicePub }) };
}

function claimOf(value: unknown): SlotClaim | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const slot = text(value, "slot");
  const phase = text(value, "phase");
  const generation = count(value, "generation");
  if (slot === undefined || generation === undefined) return undefined;
  const owner = text(value, "owner");
  if (phase === "enrolling") {
    if (owner === undefined) return undefined;
    const [signPub, devicePub] = [text(value, "signPub"), text(value, "devicePub")];
    return {
      slot,
      phase,
      owner,
      generation,
      ...(signPub === undefined ? {} : { signPub }),
      ...(devicePub === undefined ? {} : { devicePub }),
    };
  }
  const hosts: unknown = Reflect.get(value, "hosts");
  const last: unknown = Reflect.get(value, "last");
  const joined: unknown = Reflect.get(value, "joined");
  if (phase !== "retiring" || !Array.isArray(hosts) || typeof last !== "boolean" || typeof joined !== "boolean") {
    return undefined;
  }
  return { slot, phase, generation, joined, hosts: hosts.filter((host) => typeof host === "string"), last };
}

/** The stored record as it is, without the earlier release's entry: what a reader that must not write may see. */
export async function storedRecord(storage: KeyValueStore): Promise<MeshRecord> {
  const saved: unknown = await storage.get(RECORD_KEY);
  if (typeof saved !== "object" || saved === null) return EMPTY;
  const listed: unknown = Reflect.get(saved, "memberships");
  const claimed: unknown = Reflect.get(saved, "slots");
  const memberships = Array.isArray(listed) ? listed.flatMap((entry) => heldOf(entry) ?? []) : [];
  const slots = Array.isArray(claimed) ? claimed.flatMap((entry) => claimOf(entry) ?? []) : [];
  const used = Math.max(0, ...memberships.map((held) => held.generation), ...slots.map((claim) => claim.generation));
  return { memberships, slots, next: Math.max(count(saved, "next") ?? 1, used + 1) };
}

export const legacyMembership = async (storage: KeyValueStore): Promise<BrowserMembership | undefined> =>
  membershipOf(await storage.get(LEGACY_KEY));

export const writeRecord = (storage: KeyValueStore, record: MeshRecord): Promise<void> =>
  storage.put(RECORD_KEY, { version: 1, memberships: record.memberships, slots: record.slots, next: record.next });

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
