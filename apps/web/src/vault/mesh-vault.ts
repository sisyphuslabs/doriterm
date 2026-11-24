import {
  type DeviceKey,
  type EntryRead,
  type KeyProtection,
  maintain,
  type MemberSigner,
  readEntry,
  resolveVault,
  type VaultContext,
  type VaultDoc,
  writeEntry,
} from "@doriface/vault";
import { RevisionLedger } from "typevault/core";
import type { KeyValueStore } from "../storage/idb.ts";
import { syncVault, type VaultReplica } from "./vault-sync.ts";

export const SONIOX_ENTRY = "soniox";
export const SONIOX_DEFAULTS = { model: "stt-rt-v6", baseUrl: "https://api.soniox.com" } as const;

export interface MeshMember {
  readonly mesh: string;
  /** signPubs of the current members, from this device's verified mesh records. */
  readonly members: ReadonlySet<string>;
  readonly self: MemberSigner;
}

export interface MeshVaultDeps {
  readonly replicas: () => Promise<readonly VaultReplica[]>;
  /** This device's place in the mesh, or undefined when it has not joined one. */
  readonly member: () => Promise<MeshMember | undefined>;
  readonly key: () => Promise<DeviceKey>;
  readonly storage: KeyValueStore;
  readonly now: () => string;
}

/** What Settings shows about the Soniox key: never the key itself. */
export type SonioxView =
  | { readonly kind: "none" }
  | { readonly kind: "locked" }
  | { readonly kind: "rolled-back" }
  | {
      readonly kind: "saved";
      readonly model: string;
      readonly baseUrl: string;
      readonly rev: number;
      /** How many member devices hold a key to it now. */
      readonly openers: number;
      /** A device that could open it was removed: the key should be replaced at Soniox. */
      readonly replace: boolean;
    };

export interface VaultMember {
  readonly signPub: string;
  readonly protection: KeyProtection;
  readonly self: boolean;
  readonly opens: boolean;
}

export interface MeshVaultSnapshot {
  readonly phase: "loading" | "not-member" | "offline" | "ready" | "failed";
  readonly message?: string;
  readonly soniox: SonioxView;
  readonly members: readonly VaultMember[];
  readonly protection: KeyProtection | undefined;
}

export interface SonioxKey {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl: string;
}

const LEDGER = "vault-ledger";
const INITIAL: MeshVaultSnapshot = { phase: "loading", soniox: { kind: "none" }, members: [], protection: undefined };

function ledgerOf(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).filter((pair): pair is [string, number] => Number.isSafeInteger(pair[1])),
  );
}

const text = (read: EntryRead & { kind: "open" }, field: string, fallback: string): string => {
  const value = read.payload.fields[field]?.value;
  return typeof value === "string" && value !== "" ? value : fallback;
};

/**
 * This device's view of the mesh vault: syncs the `doriface-vault` document with every reachable machine, keeps the
 * vault (announcing this device, wrapping new members, rotating after a removal), and reads and writes the Soniox entry.
 * Decrypted values are returned to the caller only by `sonioxKey()`; the snapshot never holds one.
 */
export class MeshVault {
  readonly #deps: MeshVaultDeps;
  readonly #listeners = new Set<() => void>();
  #snapshot: MeshVaultSnapshot = INITIAL;
  #doc: VaultDoc | undefined;
  #ledger: RevisionLedger | undefined;

  constructor(deps: MeshVaultDeps) {
    this.#deps = deps;
  }

  get snapshot(): MeshVaultSnapshot {
    return this.#snapshot;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  sync(): Promise<void> {
    return this.#round(async (doc, ctx) => maintain(doc, ctx));
  }

  /** With no connection: says whether this device is a member that only needs a machine, or not one at all. */
  async offline(): Promise<void> {
    const ctx = await this.#context().catch(() => undefined);
    this.#set({ ...INITIAL, phase: ctx === undefined ? "not-member" : "offline" });
  }

  /** Encrypts the Soniox entry on this device and writes it to every reachable machine; the key never leaves in clear. */
  saveSoniox(key: SonioxKey): Promise<void> {
    const fields = {
      $default: { type: "secret", value: key.apiKey },
      model: { type: "text", value: key.model },
      base_url: { type: "text", value: key.baseUrl },
    } as const;
    return this.#round(async (doc, ctx) => writeEntry(await maintain(doc, ctx), ctx, SONIOX_ENTRY, fields), true);
  }

  /** The Soniox key in memory, for one dictation; undefined when there is none this device can open. */
  async sonioxKey(): Promise<SonioxKey | undefined> {
    const ctx = await this.#context();
    if (this.#doc === undefined || ctx === undefined) return undefined;
    const read = await readEntry(this.#doc, ctx, SONIOX_ENTRY);
    if (read.kind !== "open") return undefined;
    return {
      apiKey: text(read, "$default", ""),
      model: text(read, "model", SONIOX_DEFAULTS.model),
      baseUrl: text(read, "base_url", SONIOX_DEFAULTS.baseUrl),
    };
  }

  async #context(): Promise<VaultContext | undefined> {
    const member = await this.#deps.member();
    if (member === undefined || !member.members.has(member.self.signPub)) return undefined;
    this.#ledger ??= new RevisionLedger(ledgerOf(await this.#deps.storage.get(LEDGER)));
    return { ...member, key: await this.#deps.key(), ledger: this.#ledger, now: this.#deps.now };
  }

  async #round(step: (doc: VaultDoc, ctx: VaultContext) => Promise<VaultDoc>, rethrow = false): Promise<void> {
    try {
      const ctx = await this.#context();
      if (ctx === undefined) return this.#set({ ...INITIAL, phase: "not-member" });
      const { doc } = await syncVault(await this.#deps.replicas(), (merged) => step(merged, ctx));
      this.#doc = doc;
      if (this.#ledger?.dirty === true) await this.#deps.storage.put(LEDGER, this.#ledger.snapshot());
      this.#set(await this.#view(doc, ctx));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.#set({ ...this.#snapshot, phase: "failed", message });
      if (rethrow) throw cause;
    }
  }

  async #view(doc: VaultDoc, ctx: VaultContext): Promise<MeshVaultSnapshot> {
    const { devices, tier } = resolveVault(doc, ctx);
    const holders = new Set(Object.keys(tier === undefined ? {} : (doc.wraps[tier.id] ?? {})));
    const members = [...devices.values()].map((device) => ({
      signPub: device.signPub,
      protection: device.protection,
      self: device.signPub === ctx.self.signPub,
      opens: holders.has(device.signPub),
    }));
    const read = await readEntry(doc, ctx, SONIOX_ENTRY);
    const soniox: SonioxView =
      read.kind === "open"
        ? {
            kind: "saved",
            model: text(read, "model", SONIOX_DEFAULTS.model),
            baseUrl: text(read, "base_url", SONIOX_DEFAULTS.baseUrl),
            rev: read.rev,
            openers: members.filter((member) => member.opens).length,
            replace: read.payload.needsRotation === true,
          }
        : read.kind === "missing"
          ? { kind: "none" }
          : { kind: read.kind };
    return { phase: "ready", soniox, members, protection: ctx.key.protection };
  }

  #set(next: MeshVaultSnapshot): void {
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }
}
