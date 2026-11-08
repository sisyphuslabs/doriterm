import { cardOf, hashOf, type MemberKind, parseRecord, type Signed, verifyCard, viewOf } from "@doriface/mesh";
import type { MemberTarget } from "../connection/settings.ts";
import { deviceStore, type KeyValueStore } from "../storage/idb.ts";

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

const KEY = "mesh-membership";

const text = (value: object, key: string): string | undefined => {
  const raw: unknown = Reflect.get(value, key);
  return typeof raw === "string" ? raw : undefined;
};

const isSigned = (value: unknown): value is Signed =>
  typeof value === "object" && value !== null && text(value, "body") !== undefined && text(value, "sig") !== undefined;

function membershipOf(value: unknown): BrowserMembership | undefined {
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

/** The membership in per-device storage; a malformed value reads as no membership rather than a broken one. */
export class MembershipStore {
  readonly #storage: KeyValueStore;

  constructor(storage: KeyValueStore = deviceStore) {
    this.#storage = storage;
  }

  async read(): Promise<BrowserMembership | undefined> {
    return membershipOf(await this.#storage.get(KEY));
  }

  /** Stores a checked welcome; false when a membership of another mesh is held, which wins (the joiner's adopt rule). */
  async adopt(next: BrowserMembership): Promise<boolean> {
    const held = await this.read();
    if (held !== undefined && held.meshId !== next.meshId) return false;
    await this.#storage.put(KEY, next);
    return true;
  }
}

/** One member as every member sees it: its current name and Noise key from the view, its kind and hostId from its card. */
export interface MeshMember {
  readonly signPub: string;
  readonly hostId: string;
  readonly name: string;
  readonly noisePub: string;
  readonly kind: MemberKind;
}

export function membersOf(records: readonly Signed[]): readonly MeshMember[] {
  const view = viewOf(records);
  const byHash = new Map(records.map((record) => [hashOf(record), record]));
  return [...view.members].flatMap((signPub): MeshMember[] => {
    const governing = byHash.get(view.governing.get(signPub) ?? "");
    const body = governing === undefined ? undefined : parseRecord(governing);
    const signed = body === undefined ? undefined : cardOf(body);
    const card = signed === undefined ? undefined : verifyCard(signed);
    if (card === undefined) return [];
    const name = view.name.get(signPub) ?? card.name;
    const noisePub = view.noise.get(signPub) ?? card.noisePub;
    return [{ signPub, hostId: card.hostId, name, noisePub, kind: card.kind ?? "machine" }];
  });
}

/** The machines a client may open a session to, as the connection roster names them: a client is reached, never dialed. */
export const reachableTargets = (members: readonly MeshMember[]): readonly MemberTarget[] =>
  members
    .filter((member) => member.kind === "machine")
    .map((member) => ({ hostId: member.hostId, hostName: member.name, hostKey: member.noisePub, directUrl: "" }));
