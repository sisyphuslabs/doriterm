import { base64urlDecode, base64urlEncode } from "@doriface/crypto";
import { isKey } from "@doriface/mesh";
import { join } from "node:path";
import { isRecord, readJson, writePrivateJson } from "../state/files.ts";

const TTL = 90 * 24 * 60 * 60 * 1_000;
const BUCKETS = [4096, 16384, 65536];
const MAX_OWNERS = 128;

export interface BlobOwner {
  readonly devicePub: string;
  readonly signPub: string;
}

export interface RestoreEnvelope {
  readonly lookup: string;
  readonly version: number;
  readonly epoch: number;
  readonly blob: Uint8Array;
}

interface Stored extends Omit<RestoreEnvelope, "blob">, BlobOwner {
  readonly blob: string;
  readonly updatedAt: number;
}

const sameOwner = (prior: BlobOwner, owner: BlobOwner): boolean =>
  prior.signPub === owner.signPub && prior.devicePub === owner.devicePub;
const validNumber = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

function stored(raw: unknown): raw is Stored {
  if (!isRecord(raw)) return false;
  const { devicePub, signPub, lookup, version, epoch, blob, updatedAt } = raw;
  return (
    isKey(devicePub) &&
    isKey(signPub) &&
    isKey(lookup) &&
    validNumber(version) &&
    validNumber(epoch) &&
    validNumber(updatedAt) &&
    typeof blob === "string" &&
    BUCKETS.some((size) => Math.ceil((4 * size) / 3) === blob.length) &&
    /^[A-Za-z0-9_-]+$/.test(blob)
  );
}

/** Atomic holder store. No owner information is returned by an anonymous lookup. */
export class RestoreBlobs {
  readonly #path: string;
  #rows: Stored[];

  constructor(stateDir: string) {
    this.#path = join(stateDir, "restore-blobs.json");
    const previous: unknown = readJson(this.#path);
    this.#rows = Array.isArray(previous) ? previous.filter(stored).slice(0, MAX_OWNERS) : [];
  }

  get empty(): boolean {
    return this.#rows.length === 0;
  }

  put(owner: BlobOwner, envelope: RestoreEnvelope, now: number): boolean {
    const { lookup, version, epoch, blob } = envelope;
    if (
      !isKey(owner.devicePub) ||
      !isKey(owner.signPub) ||
      !isKey(lookup) ||
      !validNumber(version) ||
      !validNumber(epoch) ||
      !BUCKETS.includes(blob.byteLength)
    )
      return false;
    this.prune(() => true, now);
    const prior = this.#rows.find((row) => row.signPub === owner.signPub);
    if (this.#rows.some((row) => row.lookup === lookup && !sameOwner(row, owner))) return false;
    if (prior !== undefined && (!sameOwner(prior, owner) || version < prior.version)) return false;
    const encoded = base64urlEncode(blob);
    if (prior?.version === version) return prior.blob === encoded && prior.lookup === lookup && prior.epoch === epoch;
    if (prior === undefined && this.#rows.length >= MAX_OWNERS) return false;
    this.#replace([
      ...this.#rows.filter((row) => row !== prior),
      { ...owner, lookup, version, epoch, blob: encoded, updatedAt: now },
    ]);
    return true;
  }

  get(lookup: string, now: number): (RestoreEnvelope & { readonly updatedAt: number }) | undefined {
    this.prune(() => true, now);
    const value = this.#rows.find((row) => row.lookup === lookup);
    if (value === undefined) return undefined;
    const { version, epoch, updatedAt, blob } = value;
    return { lookup, version, epoch, updatedAt, blob: base64urlDecode(blob) };
  }

  owns(lookup: string, owner: BlobOwner, now: number): boolean {
    this.prune(() => true, now);
    return this.#rows.some((row) => row.lookup === lookup && sameOwner(row, owner));
  }

  touch(owner: BlobOwner, now: number): void {
    this.prune(() => true, now);
    if (!this.#rows.some((row) => sameOwner(row, owner) && row.updatedAt < now)) return;
    this.#replace(this.#rows.map((row) => (sameOwner(row, owner) ? { ...row, updatedAt: now } : row)));
  }

  remove(owner: BlobOwner, now: number): boolean {
    this.prune(() => true, now);
    return this.#replace(this.#rows.filter((row) => !sameOwner(row, owner)));
  }

  prune(current: (owner: BlobOwner) => boolean, now: number): void {
    this.#replace(this.#rows.filter((row) => row.updatedAt > now - TTL && current(row)));
  }

  #replace(rows: Stored[]): boolean {
    if (rows.length === this.#rows.length && rows.every((row, i) => row === this.#rows[i])) return false;
    writePrivateJson(this.#path, rows);
    this.#rows = rows;
    return true;
  }
}
