/**
 * The objects a release leaves in the bucket besides its files (#1969): the `.complete` record of every file's hash,
 * the channel pointer, and the channel's signed host manifest. Shared by the mirror (release-mirror.ts) and the channel
 * operations (release-channel.ts); the Worker (apps/get) reads all three.
 */
import { signRelease } from "../../packages/crypto/src/release.ts";
import { type Pointer, parsePointer } from "../../apps/get/src/channel.ts";
import { type Channel, completeKey, hostManifestKey, isVersion, pointerKey } from "../../apps/get/src/names.ts";
import type { ObjectStore, StoredItem } from "./r2-store.ts";

export interface FileRecord {
  readonly sha256: string;
  readonly size: number;
}

export interface CompleteRecord {
  readonly version: string;
  readonly minimum?: string;
  readonly files: Readonly<Record<string, FileRecord>>;
  readonly mirroredAt: string;
  readonly runId: string;
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const json = (value: unknown): Uint8Array => utf8(`${JSON.stringify(value, null, 2)}\n`);
const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

export function parseComplete(bytes: Uint8Array): CompleteRecord {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const version = field(value, "version");
  const minimum = field(value, "minimum");
  const filesValue = field(value, "files");
  if (typeof version !== "string" || !isVersion(version)) throw new Error(".complete has no version");
  if (minimum !== undefined && (typeof minimum !== "string" || !isVersion(minimum))) {
    throw new Error(".complete has a malformed minimum");
  }
  const files: Record<string, FileRecord> = {};
  for (const [name, entry] of Object.entries(typeof filesValue === "object" && filesValue !== null ? filesValue : {})) {
    const sha256 = field(entry, "sha256");
    const size = field(entry, "size");
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256) || typeof size !== "number") {
      throw new Error(`.complete has a malformed entry for ${name}`);
    }
    files[name] = { sha256, size };
  }
  return {
    version,
    files,
    mirroredAt: String(field(value, "mirroredAt") ?? ""),
    runId: String(field(value, "runId") ?? ""),
    ...(minimum === undefined ? {} : { minimum }),
  };
}

export const completeBytes = (record: CompleteRecord): Uint8Array => json(record);

export async function readComplete(store: ObjectStore, version: string): Promise<CompleteRecord> {
  const item = await store.get(completeKey(version));
  if (item === null) throw new Error(`${version} is not mirrored: releases/v${version}/.complete is missing`);
  return parseComplete(item.body);
}

export const HOST_TARGETS = ["linux-x64", "linux-arm64", "mac-x64", "mac-arm64"] as const;

export interface HostManifest {
  readonly version: string;
  readonly rollout: number;
  readonly minimum?: string;
  readonly targets: Readonly<Record<string, { readonly url: string; readonly sha256: string; readonly size: number }>>;
}

/** The manifest a host reads at /host/<channel>/manifest.json, for a mirrored version. */
export function hostManifest(origin: string, channel: Channel, record: CompleteRecord, rollout: number): HostManifest {
  const targets: Record<string, { url: string; sha256: string; size: number }> = {};
  for (const target of HOST_TARGETS) {
    const file = `doriface-host-${target}`;
    const entry = record.files[file];
    if (entry === undefined) throw new Error(`${record.version} has no ${file}`);
    targets[target] = { url: `${origin}/host/${channel}/${record.version}/${file}`, ...entry };
  }
  return {
    version: record.version,
    rollout,
    ...(record.minimum === undefined ? {} : { minimum: record.minimum }),
    targets,
  };
}

/** Writes the manifest and its detached signature; the Worker serves the pair only while it matches the pointer. */
export async function writeHostManifest(
  store: ObjectStore,
  channel: Channel,
  manifest: HostManifest,
  secretKey: Uint8Array,
): Promise<void> {
  const body = json(manifest);
  const key = hostManifestKey(channel);
  await store.put(key, body, { any: true }, "application/json");
  await store.put(`${key}.sig`, utf8(signRelease(body, secretKey)), { any: true }, "text/plain; charset=utf-8");
}

export interface CurrentPointer {
  readonly pointer: Pointer | null;
  readonly item: StoredItem | null;
}

export async function readCurrentPointer(store: ObjectStore, channel: Channel): Promise<CurrentPointer> {
  const item = await store.get(pointerKey(channel));
  if (item === null) return { pointer: null, item: null };
  const pointer = parsePointer(new TextDecoder().decode(item.body));
  if (pointer === null) throw new Error(`channels/${channel}.json is malformed; fix it by hand before moving it`);
  return { pointer, item };
}

/** Moves the pointer only over the one read (or creates it); false when another run moved it in between. */
export const writePointer = (store: ObjectStore, channel: Channel, current: CurrentPointer, next: Pointer) =>
  store.put(
    pointerKey(channel),
    json(next),
    current.item === null ? { create: true } : { replace: current.item.etag },
    "application/json",
  );
