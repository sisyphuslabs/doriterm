import { base64urlDecode, hostIdOf } from "@doriface/crypto";
import { meshIdOf, type MemberKind, parseRecord, type Signed } from "@doriface/mesh";
import type { MemberTarget } from "../connection/settings.ts";
import { deviceStore, type KeyValueStore } from "../storage/idb.ts";
import { BundleRefused, merge } from "./bundle-merge.ts";
import { bundleView, memberCards, type BundleView, type ClientKeys } from "./bundle-view.ts";
import {
  type BrowserMembership,
  changeRecord,
  DEFAULT_SLOT,
  type MeshRecord,
  membershipOf,
  memberships,
} from "./membership-list.ts";

export type { BrowserMembership } from "./membership-list.ts";
export { BundleRefused } from "./bundle-merge.ts";

export interface BundleAnchor {
  readonly mesh: string;
  readonly inviter: string;
  readonly hostId: string;
  readonly hostKey: string;
}

type Change<T> = { readonly next: MeshRecord; readonly answer: T };

/**
 * One key slot's membership in per-device storage: the mesh that slot's keys joined, if any. A browser in several meshes
 * holds one store per slot, so every rule here (one mesh per identity, the bundle only grows, a refresh must come from a
 * machine of that mesh) holds per mesh while the meshes stay apart (#2861).
 */
export class MembershipStore {
  readonly #storage: KeyValueStore;
  readonly #keys: ClientKeys | undefined;
  readonly slot: string;
  readonly #listeners = new Set<() => void>();
  readonly #sessions = new WeakSet<object>();
  readonly #refreshed = new Map<string, number>();
  #state: BundleView;

  constructor(storage: KeyValueStore = deviceStore, keys?: ClientKeys, slot: string = DEFAULT_SLOT) {
    this.#storage = storage;
    this.#keys = keys;
    this.slot = slot;
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
    return this.#mine(await memberships(this.#storage));
  }

  #mine(list: MeshRecord["memberships"]): BrowserMembership | undefined {
    return membershipOf(list.find((held) => held.keySlot === this.slot));
  }

  /** Another slot already holds this mesh: joining it again would show that mesh a second identity of this browser. */
  #refuseSecondIdentity(record: MeshRecord, mesh: string): void {
    if (record.memberships.some((held) => held.keySlot !== this.slot && held.meshId === mesh)) {
      throw new BundleRefused(`This browser is in mesh ${mesh} already.`);
    }
  }

  /** The membership and the end of this slot's join claim, in the one write: never a mesh without its slot. */
  #saved(record: MeshRecord, next: BrowserMembership): MeshRecord {
    return {
      memberships: [
        ...record.memberships.filter((held) => held.keySlot !== this.slot),
        { ...next, keySlot: this.slot },
      ],
      slots: record.slots.filter((claim) => claim.slot !== this.slot),
    };
  }

  async #change<T>(change: (record: MeshRecord) => Change<T> & { readonly shown?: BrowserMembership }): Promise<T> {
    let shown: BrowserMembership | undefined;
    const answer = await changeRecord(this.#storage, (record) => {
      const result = change(record);
      shown = result.shown;
      return result;
    });
    if (shown !== undefined) this.#show(shown);
    return answer;
  }

  async load(): Promise<void> {
    const held = await this.read();
    if (held === undefined) return;
    const records = merge([], held.records);
    this.#checkMesh(records, held.meshId);
    this.#show({ ...held, records });
  }

  /** Stores a checked welcome; false when this slot holds another mesh, which wins (the joiner's adopt rule). */
  adopt(next: BrowserMembership): Promise<boolean> {
    return this.#change((record) => {
      const held = this.#mine(record.memberships);
      if (held !== undefined && held.meshId !== next.meshId) return { next: record, answer: false };
      this.#refuseSecondIdentity(record, next.meshId);
      const saved = { ...next, records: held === undefined ? next.records : merge(held.records, next.records) };
      return { next: this.#saved(record, saved), answer: true, shown: saved };
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

  async accept(records: readonly Signed[], anchor: BundleAnchor, relayUrl = ""): Promise<void> {
    const keys = this.#keys;
    if (keys === undefined) throw new BundleRefused("The browser's keys are required to accept a roster.");
    const checked = merge([], records);
    this.#checkMesh(checked, anchor.mesh);
    const view = bundleView(checked, anchor.mesh, keys);
    if (view.self === undefined) throw new BundleRefused("The welcome does not admit this browser's own keys.");
    this.#checkSource(view, anchor);
    await this.#change((record) => {
      const held = this.#mine(record.memberships);
      if (held !== undefined && held.meshId !== anchor.mesh) {
        throw new BundleRefused("This browser already belongs to another mesh.");
      }
      this.#refuseSecondIdentity(record, anchor.mesh);
      const next: BrowserMembership = {
        meshId: anchor.mesh,
        records: held === undefined ? checked : merge(held.records, checked),
        signPub: keys.signPub,
        inviter: held?.inviter ?? { hostId: anchor.hostId, hostKey: anchor.hostKey },
        relayUrl: held?.relayUrl || relayUrl,
        joinedAt: held?.joinedAt ?? new Date().toISOString(),
      };
      return { next: this.#saved(record, next), answer: undefined, shown: next };
    });
  }

  async refresh(records: readonly Signed[], source: BundleAnchor): Promise<void> {
    this.#checkSource(this.#state, source);
    const known = this.#state.records;
    await this.#change((record) => {
      const held = this.#mine(record.memberships);
      if (held === undefined) throw new BundleRefused("The browser's membership was cleared.");
      const next = { ...held, records: merge(merge(known, held.records), records) };
      return { next: this.#saved(record, next), answer: undefined, shown: next };
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
