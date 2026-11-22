import { base64urlDecode, base64urlEncode, fingerprintOf } from "@doriface/crypto";
import { join } from "node:path";
import { ensureStateDir, fileStamp, isRecord, readJson, stringField, writePrivateJson } from "./files.ts";
import { withStateLock } from "./lock.ts";

const FILE = "devices.json";
export const DEVICES_FILE = FILE;

export interface PairedDevice {
  /** base64url of the device's X25519 static public key. */
  readonly clientStaticPub: string;
  readonly name: string;
  /** ISO 8601. */
  readonly pairedAt: string;
}

const fullFingerprintOf = (device: PairedDevice): string =>
  fingerprintOf(base64urlDecode(device.clientStaticPub)).replaceAll(" ", "");

/** A short handle for a device: the first two groups of its key's fingerprint, e.g. `3FA94C0E`. */
export const deviceIdOf = (device: PairedDevice): string => fullFingerprintOf(device).slice(0, 8);

/**
 * The paired-devices file (0600 JSON). Every read goes to disk, so a `doriface-host devices revoke` run by another
 * process takes effect on the next handshake.
 */
export class DeviceStore {
  readonly #dir: string;
  readonly #path: string;
  readonly #lockTimeoutMs: number | undefined;
  #paired: { readonly stamp: string; readonly keys: ReadonlySet<string> } | undefined;

  constructor(stateDir: string, options: { readonly lockTimeoutMs?: number } = {}) {
    this.#dir = ensureStateDir(stateDir);
    this.#path = join(this.#dir, FILE);
    this.#lockTimeoutMs = options.lockTimeoutMs;
  }

  list(): readonly PairedDevice[] {
    const value = readJson(this.#path);
    if (value === undefined) return [];
    if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["devices"])) {
      throw new Error(`${FILE}: unsupported format`);
    }
    return value["devices"].map((entry: unknown) => {
      if (!isRecord(entry)) throw new Error(`${FILE}: a device entry is not an object`);
      return {
        clientStaticPub: stringField(entry, "clientStaticPub", FILE),
        name: stringField(entry, "name", FILE),
        pairedAt: stringField(entry, "pairedAt", FILE),
      };
    });
  }

  /**
   * The paired keys, for a check on every request: re-read only when devices.json changed on disk, so a revoke written by
   * another process (`doriface-host devices revoke`) is seen by the next check, at the cost of one stat.
   */
  pairedKeys(): ReadonlySet<string> {
    const stamp = fileStamp(this.#path);
    if (stamp !== undefined && this.#paired?.stamp === stamp) return this.#paired.keys;
    const keys = new Set(this.list().map((device) => device.clientStaticPub));
    this.#paired = stamp === undefined ? undefined : { stamp, keys };
    return keys;
  }

  has(clientStaticPub: Uint8Array): boolean {
    const key = base64urlEncode(clientStaticPub);
    return this.list().some((device) => device.clientStaticPub === key);
  }

  /** Records a newly paired device, replacing an earlier entry for the same key. */
  add(clientStaticPub: Uint8Array, name: string, now = new Date()): PairedDevice {
    const device = { clientStaticPub: base64urlEncode(clientStaticPub), name, pairedAt: now.toISOString() };
    return this.#locked(() => {
      const others = this.list().filter((entry) => entry.clientStaticPub !== device.clientStaticPub);
      this.#save([...others, device]);
      return device;
    });
  }

  /**
   * Removes the device whose short id, full fingerprint or base64url key is `handle`; returns what was removed. A short
   * id shared by several devices is refused rather than revoking all of them.
   */
  revoke(handle: string): readonly PairedDevice[] {
    const id = handle.replaceAll(" ", "").toUpperCase();
    return this.#locked(() => {
      const devices = this.list();
      const removed = devices.filter(
        (device) => device.clientStaticPub === handle || fullFingerprintOf(device) === id || deviceIdOf(device) === id,
      );
      if (removed.length > 1) {
        throw new Error(`${handle} matches ${removed.length} devices; revoke one by its full fingerprint`);
      }
      if (removed.length > 0) this.#save(devices.filter((device) => !removed.includes(device)));
      return removed;
    });
  }

  /** Removes every device whose key is in `keys`; the caller holds the state lock. Returns what was removed. */
  removeKeysHeld(keys: ReadonlySet<string>): readonly PairedDevice[] {
    const devices = this.list();
    const removed = devices.filter((device) => keys.has(device.clientStaticPub));
    if (removed.length > 0) this.#save(devices.filter((device) => !keys.has(device.clientStaticPub)));
    return removed;
  }

  #locked<T>(fn: () => T): T {
    return withStateLock(this.#dir, fn, this.#lockTimeoutMs);
  }

  #save(devices: readonly PairedDevice[]): void {
    writePrivateJson(this.#path, { version: 1, devices });
  }
}
