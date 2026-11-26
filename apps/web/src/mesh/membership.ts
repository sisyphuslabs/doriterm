import { base64urlDecode, hostIdOf } from "@doriface/crypto";
import { door, meshIdOf, type MemberKind, parseRecord, type Signed } from "@doriface/mesh";
import type { MemberTarget } from "../connection/settings.ts";
import { deviceStore, type KeyValueStore } from "../storage/idb.ts";
import { DEFAULT_SLOT } from "../storage/key-slot.ts";
import { bundleView, memberCards, type BundleView, type ClientKeys } from "./bundle-view.ts";
import {
  type BrowserMembership,
  type HeldMembership,
  membershipOf,
  memberships,
  readHeld,
  removeHeld,
  withMeshLock,
  writeHeld,
} from "./membership-list.ts";

export type { BrowserMembership } from "./membership-list.ts";

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

  #mine(list: readonly HeldMembership[]): BrowserMembership | undefined {
    return membershipOf(list.find((held) => held.keySlot === this.slot));
  }

  /** Another slot already holds this mesh: joining it again would show that mesh a second identity of this browser. */
  #refuseSecondIdentity(list: readonly HeldMembership[], mesh: string): void {
    if (list.some((held) => held.keySlot !== this.slot && held.meshId === mesh)) {
      throw new BundleRefused(`This browser is in mesh ${mesh} already.`);
    }
  }

  async #save(next: BrowserMembership): Promise<void> {
    await writeHeld(this.#storage, { ...next, keySlot: this.slot });
    this.#show(next);
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
    return this.#write(async () => {
      const list = await readHeld(this.#storage);
      const held = this.#mine(list);
      if (held !== undefined && held.meshId !== next.meshId) return false;
      this.#refuseSecondIdentity(list, next.meshId);
      const records = held === undefined ? next.records : merge(held.records, next.records);
      await this.#save({ ...next, records });
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
      const list = await readHeld(this.#storage);
      const held = this.#mine(list);
      if (held !== undefined && held.meshId !== anchor.mesh) {
        throw new BundleRefused("This browser already belongs to another mesh.");
      }
      this.#refuseSecondIdentity(list, anchor.mesh);
      const next: BrowserMembership = {
        meshId: anchor.mesh,
        records: held === undefined ? checked : merge(held.records, checked),
        signPub: this.#keys.signPub,
        inviter: held?.inviter ?? { hostId: anchor.hostId, hostKey: anchor.hostKey },
        relayUrl: held?.relayUrl || relayUrl,
        joinedAt: held?.joinedAt ?? new Date().toISOString(),
      };
      await this.#save(next);
    });
  }

  refresh(records: readonly Signed[], source: BundleAnchor): Promise<void> {
    return this.#write(async () => {
      this.#checkSource(this.#state, source);
      const held = this.#mine(await readHeld(this.#storage));
      if (held === undefined) throw new BundleRefused("The browser's membership was cleared.");
      await this.#save({ ...held, records: merge(merge(this.#state.records, held.records), records) });
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
      await removeHeld(this.#storage, this.slot);
      this.#show(undefined);
    });
  }

  #write<T>(action: () => Promise<T>): Promise<T> {
    return withMeshLock(action);
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
