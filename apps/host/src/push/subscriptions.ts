import { type PushPrefs, type PushSubscriptionKeys, parsePushClientLine } from "@doriface/protocol";
import { join } from "node:path";
import { ensureStateDir, isRecord, readJson, writePrivateJson } from "../state/files.ts";
import { withStateLock } from "../state/lock.ts";

const FILE = "push-subscriptions.json";
/** A device holds one subscription per browser profile; a few cover its profiles and installed apps. */
export const MAX_PER_OWNER = 8;

/** The device a subscription belongs to: its key (base64url), or `loopback` for the token-holding local client. */
export const LOOPBACK_OWNER = "loopback";

export interface StoredSubscription extends PushSubscriptionKeys {
  readonly owner: string;
  readonly prefs: PushPrefs;
  /** ISO 8601. */
  readonly createdAt: string;
}

/** Reuses the wire parser, so the file holds nothing a subscribe line could not carry. */
function entryOf(value: unknown): StoredSubscription {
  if (!isRecord(value) || typeof value["owner"] !== "string" || typeof value["createdAt"] !== "string") {
    throw new Error(`${FILE}: a malformed subscription`);
  }
  const line = parsePushClientLine(JSON.stringify({ t: "subscribe", subscription: value, prefs: value["prefs"] }));
  if (line.t !== "subscribe") throw new Error(`${FILE}: a malformed subscription`);
  return { ...line.subscription, owner: value["owner"], prefs: line.prefs, createdAt: value["createdAt"] };
}

/** `push-subscriptions.json` (0600, under the state lock). Every read goes to disk, as the devices file does. */
export class SubscriptionStore {
  readonly #dir: string;
  readonly #path: string;

  constructor(stateDir: string) {
    this.#dir = ensureStateDir(stateDir);
    this.#path = join(this.#dir, FILE);
  }

  list(): readonly StoredSubscription[] {
    const value = readJson(this.#path);
    if (value === undefined) return [];
    if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["subscriptions"])) {
      throw new Error(`${FILE}: unsupported format`);
    }
    return value["subscriptions"].map(entryOf);
  }

  ofOwner(owner: string): readonly StoredSubscription[] {
    return this.list().filter((entry) => entry.owner === owner);
  }

  /** Stores or replaces the endpoint for `owner`; an endpoint has one owner, and an owner's oldest go past the cap. */
  put(owner: string, keys: PushSubscriptionKeys, prefs: PushPrefs, now = new Date()): void {
    this.#update((all) => {
      const others = all.filter((entry) => entry.endpoint !== keys.endpoint);
      const mine = others.filter((entry) => entry.owner === owner).slice(-(MAX_PER_OWNER - 1));
      const rest = others.filter((entry) => entry.owner !== owner);
      return [...rest, ...mine, { ...keys, owner, prefs, createdAt: now.toISOString() }];
    });
  }

  /** False when `owner` holds no such endpoint. */
  setPrefs(owner: string, endpoint: string, prefs: PushPrefs): boolean {
    let found = false;
    this.#update((all) =>
      all.map((entry) => {
        if (entry.owner !== owner || entry.endpoint !== endpoint) return entry;
        found = true;
        return { ...entry, prefs };
      }),
    );
    return found;
  }

  remove(owner: string, endpoint: string): void {
    this.#update((all) => all.filter((entry) => entry.owner !== owner || entry.endpoint !== endpoint));
  }

  /** The push service said the endpoint is gone (404 or 410). */
  removeEndpoint(endpoint: string): void {
    this.#update((all) => all.filter((entry) => entry.endpoint !== endpoint));
  }

  /** Drops every subscription of a device that is no longer paired (a revoke); the loopback owner stays. */
  keepOwners(paired: ReadonlySet<string>): void {
    withStateLock(this.#dir, () => this.keepOwnersHeld(paired));
  }

  /** The mesh index rebuild already owns the state lock. */
  keepOwnersHeld(owners: ReadonlySet<string>): void {
    const before = this.list();
    const after = before.filter((entry) => entry.owner === LOOPBACK_OWNER || owners.has(entry.owner));
    if (after.length !== before.length) writePrivateJson(this.#path, { version: 1, subscriptions: after });
  }

  #update(change: (all: readonly StoredSubscription[]) => readonly StoredSubscription[]): void {
    withStateLock(this.#dir, () => {
      const before = this.list();
      const after = change(before);
      if (after.length === before.length && after.every((entry, i) => entry === before[i])) return;
      writePrivateJson(this.#path, { version: 1, subscriptions: after });
    });
  }
}
