import { base64urlDecode, hostIdOf } from "@doriface/crypto";
import { door, meshIdOf, type MemberKind, parseRecord, type Signed } from "@doriface/mesh";
import type { MemberTarget } from "../connection/settings.ts";
import { deviceStore, type KeyValueStore } from "../storage/idb.ts";
import { bundleView, memberCards, type BundleView, type ClientKeys } from "./bundle-view.ts";

export interface BundleAnchor {
  readonly mesh: string;
  readonly inviter: string;
  readonly hostId: string;
  readonly hostKey: string;
}

export class BundleRefused extends Error {
  override readonly name = "BundleRefused";
}

function merge(held: readonly Signed[], incoming: readonly Signed[]): readonly Signed[] {
  const records = [...held];
  for (const record of incoming) {
    const verdict = door(record, records);
    if (!verdict.ok) {
      if (verdict.reason === "already stored") continue;
      throw new BundleRefused(`The mesh record was refused: ${verdict.reason}.`);
    }
    records.push(record);
  }
  return records;
}

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
  readonly #keys: ClientKeys | undefined;
  readonly #listeners = new Set<() => void>();
  readonly #sessions = new WeakSet<object>();
  readonly #refreshed = new Map<string, number>();
  #state: BundleView;
  #writes: Promise<unknown> = Promise.resolve();

  constructor(storage: KeyValueStore = deviceStore, keys?: ClientKeys) {
    this.#storage = storage;
    this.#keys = keys;
    this.#state = bundleView([], "", keys ?? { signPub: "", devicePub: "" });
  }

  snapshot = (): BundleView => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #show(membership: BrowserMembership | undefined): void {
    const keys = this.#keys ?? { signPub: "", devicePub: "" };
    this.#state = bundleView(membership?.records ?? [], membership?.meshId ?? "", keys);
    for (const listener of this.#listeners) listener();
  }

  async read(): Promise<BrowserMembership | undefined> {
    return membershipOf(await this.#storage.get(KEY));
  }

  async load(): Promise<void> {
    const held = await this.read();
    if (held === undefined) return;
    const records = merge([], held.records);
    this.#checkMesh(records, held.meshId);
    this.#show({ ...held, records });
  }

  /** Stores a checked welcome; false when a membership of another mesh is held, which wins (the joiner's adopt rule). */
  adopt(next: BrowserMembership): Promise<boolean> {
    return this.#write(async () => {
      const held = await this.read();
      if (held !== undefined && held.meshId !== next.meshId) return false;
      const records = held === undefined ? next.records : merge(held.records, next.records);
      const saved = { ...next, records };
      await this.#storage.put(KEY, saved);
      this.#show(saved);
      return true;
    });
  }

  #checkMesh(records: readonly Signed[], mesh: string): void {
    const founds = records.filter((record) => parseRecord(record)?.type === "found");
    const found = founds[0];
    if (founds.length !== 1 || found === undefined || meshIdOf(found) !== mesh) {
      throw new BundleRefused("The bundle does not found the offered mesh.");
    }
  }

  #checkSource(view: BundleView, anchor: BundleAnchor): void {
    const machine = view.machines.find((member) => member.hostId === anchor.hostId);
    if (
      view.mesh !== anchor.mesh ||
      machine?.hostKey !== anchor.hostKey ||
      hostIdOf(base64urlDecode(anchor.inviter)) !== machine.hostId
    ) {
      throw new BundleRefused("The bundle is not from the authenticated machine.");
    }
  }

  accept(records: readonly Signed[], anchor: BundleAnchor, relayUrl = ""): Promise<void> {
    return this.#write(async () => {
      if (this.#keys === undefined) throw new BundleRefused("The browser's keys are required to accept a roster.");
      const checked = merge([], records);
      this.#checkMesh(checked, anchor.mesh);
      const view = bundleView(checked, anchor.mesh, this.#keys);
      if (view.self === undefined) throw new BundleRefused("The welcome does not admit this browser's own keys.");
      this.#checkSource(view, anchor);
      const held = await this.read();
      if (held !== undefined && held.meshId !== anchor.mesh) {
        throw new BundleRefused("This browser already belongs to another mesh.");
      }
      const next: BrowserMembership = {
        meshId: anchor.mesh,
        records: held === undefined ? checked : merge(held.records, checked),
        signPub: this.#keys.signPub,
        inviter: held?.inviter ?? { hostId: anchor.hostId, hostKey: anchor.hostKey },
        relayUrl: held?.relayUrl || relayUrl,
        joinedAt: held?.joinedAt ?? new Date().toISOString(),
      };
      await this.#storage.put(KEY, next);
      this.#show(next);
    });
  }

  refresh(records: readonly Signed[], source: BundleAnchor): Promise<void> {
    return this.#write(async () => {
      this.#checkSource(this.#state, source);
      const held = await this.read();
      if (held === undefined) throw new BundleRefused("The browser's membership was cleared.");
      const next = { ...held, records: merge(merge(this.#state.records, held.records), records) };
      await this.#storage.put(KEY, next);
      this.#show(next);
    });
  }

  claimRefresh(hostId: string, session: object, now = Date.now()): boolean {
    if (this.#sessions.has(session)) return false;
    this.#sessions.add(session);
    const prior = this.#refreshed.get(hostId);
    if (prior !== undefined && now - prior < 600_000) return false;
    this.#refreshed.set(hostId, now);
    return true;
  }

  forget(): Promise<void> {
    return this.#write(async () => {
      await this.#storage.put(KEY, null);
      this.#show(undefined);
    });
  }

  #write<T>(action: () => Promise<T>): Promise<T> {
    const locked = async (): Promise<T> => {
      const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
      return locks === undefined ? action() : locks.request("doriface-mesh-bundle", action);
    };
    const result = this.#writes.then(locked, locked);
    this.#writes = result;
    return result;
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
  return memberCards(records).map((card) => ({
    signPub: card.signPub,
    hostId: card.hostId,
    name: card.name,
    noisePub: card.noisePub,
    kind: card.kind ?? "machine",
  }));
}

/** The machines a client may open a session to, as the connection roster names them: a client is reached, never dialed. */
export const reachableTargets = (members: readonly MeshMember[]): readonly MemberTarget[] =>
  members
    .filter((member) => member.kind === "machine")
    .map((member) => ({ hostId: member.hostId, hostName: member.name, hostKey: member.noisePub, directUrl: "" }));
