import { base64urlDecode, hostIdOf } from "@doriface/crypto";
import { door, meshIdOf, parseRecord, type Signed } from "@doriface/mesh";
import type { KeyValueStore } from "../storage/idb.ts";
import { bundleView, type BundleView, type ClientKeys } from "./bundle-view.ts";

export interface BundleAnchor {
  readonly mesh: string;
  readonly inviter: string;
  readonly hostId: string;
  readonly hostKey: string;
}

export class BundleRefused extends Error {
  override readonly name = "BundleRefused";
}

function merge(held: readonly Signed[], incoming: readonly Signed[], duplicates: boolean): readonly Signed[] {
  const records = [...held];
  for (const record of incoming) {
    const verdict = door(record, records);
    if (!verdict.ok) {
      if (duplicates && verdict.reason === "already stored") continue;
      throw new BundleRefused(`The mesh record was refused: ${verdict.reason}.`);
    }
    records.push(record);
  }
  return records;
}

function recordsOf(value: unknown): readonly Signed[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof Reflect.get(entry, "body") === "string" &&
        typeof Reflect.get(entry, "sig") === "string",
    )
  ) {
    throw new BundleRefused("The saved mesh bundle cannot be read.");
  }
  return value;
}

/** One verified bundle per mesh. No received record becomes visible before the whole response commits. */
export class BundleStore {
  readonly #storage: KeyValueStore;
  readonly #keys: ClientKeys;
  readonly #listeners = new Set<() => void>();
  readonly #sessions = new WeakSet<object>();
  readonly #refreshed = new Map<string, number>();
  #state: BundleView;
  #writes: Promise<unknown> = Promise.resolve();

  constructor(storage: KeyValueStore, keys: ClientKeys) {
    this.#storage = storage;
    this.#keys = keys;
    this.#state = bundleView([], "", keys);
  }

  snapshot = (): BundleView => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #show(records: readonly Signed[], mesh: string): void {
    this.#state = bundleView(records, mesh, this.#keys);
    for (const listener of this.#listeners) listener();
  }

  async load(): Promise<void> {
    const mesh = await this.#storage.get("mesh.current");
    if (typeof mesh !== "string") return;
    const records = merge([], recordsOf(await this.#storage.get(`mesh.bundle.${mesh}`)), false);
    this.#checkMesh(records, mesh);
    this.#show(records, mesh);
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
    if (view.mesh !== anchor.mesh || machine?.hostKey !== anchor.hostKey) {
      throw new BundleRefused("The bundle is not from the authenticated machine.");
    }
    if (hostIdOf(base64urlDecode(anchor.inviter)) !== machine.hostId) {
      throw new BundleRefused("The inviter is not the authenticated machine.");
    }
  }

  accept(records: readonly Signed[], anchor: BundleAnchor): Promise<void> {
    return this.#write(async () => {
      const checked = merge([], records, false);
      this.#checkMesh(checked, anchor.mesh);
      const view = bundleView(checked, anchor.mesh, this.#keys);
      if (view.self === undefined) throw new BundleRefused("The welcome does not admit this browser's own keys.");
      this.#checkSource(view, anchor);
      const current = await this.#storage.get("mesh.current");
      if (typeof current === "string" && current !== anchor.mesh) {
        throw new BundleRefused("This browser already belongs to another mesh.");
      }
      const saved = await this.#storage.get(`mesh.bundle.${anchor.mesh}`);
      const union = saved == null ? checked : merge(merge([], recordsOf(saved), false), checked, true);
      await this.#storage.put(`mesh.bundle.${anchor.mesh}`, union);
      await this.#storage.put("mesh.current", anchor.mesh);
      this.#show(union, anchor.mesh);
    });
  }

  refresh(records: readonly Signed[], source: BundleAnchor): Promise<void> {
    return this.#write(async () => {
      this.#checkSource(this.#state, source);
      const saved = await this.#storage.get(`mesh.bundle.${source.mesh}`);
      const held = saved == null ? this.#state.records : merge(this.#state.records, recordsOf(saved), true);
      const union = merge(held, records, true);
      await this.#storage.put(`mesh.bundle.${source.mesh}`, union);
      this.#show(union, source.mesh);
    });
  }

  /** Call before opening a roster stream; failed/old-host refreshes also consume their session's allowance. */
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
      if (this.#state.mesh !== "") await this.#storage.put(`mesh.bundle.${this.#state.mesh}`, null);
      await this.#storage.put("mesh.current", null);
      this.#show([], "");
    });
  }

  #write(action: () => Promise<void>): Promise<void> {
    const locked = async (): Promise<void> => {
      const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
      if (locks === undefined) await action();
      else await locks.request("doriface-mesh-bundle", action);
    };
    const result = this.#writes.then(locked, locked);
    this.#writes = result;
    return result;
  }
}
