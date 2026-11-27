import { parseRecord, type Signed } from "@doriface/mesh";
import {
  type IndexData,
  INDEX_RULES,
  type MemberEntry,
  type NamingEntry,
  type RevokedEntry,
} from "../mesh/authorize-index.ts";
import { isRecord } from "./files.ts";

export const MESH_FILE = "mesh.json";
/**
 * The formats this build reads. A file above the highest is refused at the guard below, before any index is rebuilt or
 * authorization runs, which is what makes an old reader refuse new semantics instead of silently dropping them.
 */
const READ_VERSIONS: ReadonlySet<number> = new Set([2, 3, 4]);
/** The formats this build reads, said on every `hello` so a writer can gate a record an older member could not read. */
export const MESH_READS: readonly number[] = [...READ_VERSIONS];
export const RESTORE_FORMAT = 4;
/** The format this build writes while it carries nothing a v2 reader cannot hold: a reader on 2 keeps working. */
const WRITE_VERSION = 2;

/**
 * `mesh.json` (section 10.1). `records` is the only source of trust; `index` is what `authorize` reads, derived from
 * the records at this `generation` by the writer, and `local`, `notices` and `readOnlyUntil` are display state.
 */
export interface MeshFile {
  /** The format this file is written in; a v2 reader only accepts 2. */
  readonly version: number;
  readonly meshId: string;
  readonly generation: number;
  /** The counter this host last signed with (or is about to: it is written before the record is signed). */
  readonly selfN: number;
  readonly records: readonly Signed[];
  readonly dangling: readonly Signed[];
  readonly local: Readonly<Record<string, unknown>>;
  readonly notices: Readonly<Record<string, unknown>>;
  readonly readOnlyUntil: string | null;
  readonly index: IndexData | undefined;
}

const isSigned = (value: unknown): value is Signed =>
  isRecord(value) && typeof value["body"] === "string" && typeof value["sig"] === "string";

function signedList(value: unknown, key: string): readonly Signed[] {
  if (!Array.isArray(value) || !value.every(isSigned)) throw new Error(`${MESH_FILE}: ${key} must be signed records`);
  return value;
}

const strings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;

function memberEntry(value: unknown): MemberEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { signPub, hostId, noisePub, devicePub, name, hcId, kind, admitter, admitId, lastSessionAt, readmittedAt } =
    value;
  if (typeof signPub !== "string" || typeof hostId !== "string" || typeof noisePub !== "string") return undefined;
  if (typeof name !== "string" || typeof hcId !== "string") return undefined;
  if (devicePub !== undefined && typeof devicePub !== "string") return undefined;
  if (kind !== undefined && kind !== "machine" && kind !== "client") return undefined;
  if (admitter !== undefined && typeof admitter !== "string") return undefined;
  if (admitId !== undefined && typeof admitId !== "string") return undefined;
  if (lastSessionAt !== undefined && !timestamp(lastSessionAt)) return undefined;
  if (readmittedAt !== undefined && !timestamp(readmittedAt)) return undefined;
  // Client indexes from before the admitter binding must be rebuilt at startup.
  if (kind === "client" && (admitter === undefined || admitId === undefined)) return undefined;
  // An index written before the kind existed says machine, which is all those members could have been.
  return {
    signPub,
    hostId,
    noisePub,
    devicePub,
    name,
    hcId,
    kind: kind === "client" ? "client" : "machine",
    admitter,
    admitId,
    ...(lastSessionAt === undefined ? {} : { lastSessionAt }),
    ...(readmittedAt === undefined ? {} : { readmittedAt }),
  };
}

function revokedEntry(value: unknown): RevokedEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { signPub, hostId, keys, restoredAt } = value;
  if (typeof signPub !== "string" || typeof hostId !== "string" || !strings(keys)) return undefined;
  if (restoredAt !== undefined && !timestamp(restoredAt)) return undefined;
  return { signPub, hostId, keys, ...(restoredAt === undefined ? {} : { restoredAt }) };
}

function namingEntry(value: unknown): NamingEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { signPub, keys } = value;
  return typeof signPub === "string" && strings(keys) ? { signPub, keys } : undefined;
}

function all<T>(value: unknown, item: (entry: unknown) => T | undefined): readonly T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map(item);
  return items.every((entry) => entry !== undefined) ? items.filter((entry) => entry !== undefined) : undefined;
}

/**
 * The persisted index, or undefined when it is missing or malformed (the host rebuilds it at start). An index with an
 * `overCap` list was written under the 12-member cap (#806): its members past the 12th are missing, so it is rebuilt.
 */
function indexData(value: unknown): IndexData | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value["generation"]) || "overCap" in value) return undefined;
  // An index built under other admission rules may hold a member the current rules leave out (#1483).
  if (value["rules"] !== INDEX_RULES) return undefined;
  const members = all(value["members"], memberEntry);
  const revoked = all(value["revoked"], revokedEntry);
  const superseded = value["superseded"];
  // An index written before `named` existed is missing it: the host rebuilds it at start (MeshStore.ensureIndex).
  const named = all(value["named"], namingEntry);
  if (members === undefined || revoked === undefined || !strings(superseded)) return undefined;
  if (named === undefined) return undefined;
  return { generation: Number(value["generation"]), rules: INDEX_RULES, members, revoked, superseded, named };
}

const objectOr = (value: unknown): Readonly<Record<string, unknown>> => (isRecord(value) ? value : {});

export function parseMeshFile(value: unknown): MeshFile {
  if (!isRecord(value) || !READ_VERSIONS.has(Number(value["version"])))
    throw new Error(`${MESH_FILE}: unsupported format`);
  const { meshId, generation, self, readOnlyUntil } = value;
  const selfN = isRecord(self) ? self["n"] : undefined;
  if (typeof meshId !== "string" || !Number.isSafeInteger(generation) || !Number.isSafeInteger(selfN)) {
    throw new Error(`${MESH_FILE}: malformed`);
  }
  return {
    version: Number(value["version"]),
    meshId,
    generation: Number(generation),
    selfN: Number(selfN),
    records: signedList(value["records"], "records"),
    dangling: signedList(value["dangling"] ?? [], "dangling"),
    local: objectOr(value["local"]),
    notices: objectOr(value["notices"]),
    readOnlyUntil: typeof readOnlyUntil === "string" ? readOnlyUntil : null,
    index: indexData(value["index"]),
  };
}

/** The outer format a reader must know for a client to mean anything: before it, a client's kind is dropped. */
export const CLIENT_FORMAT = 3;

/**
 * The version to write a file with. A client member needs {@link CLIENT_FORMAT}, because a reader that only knows version 2
 * drops `kind` and then authorizes the client's Noise key as a machine that dials the mesh stream: the exact reversal this
 * work exists to prevent, on a host that was rolled back (design of #942, section 7.1).
 */
export const writeVersionOf = (
  index: { readonly members: readonly { readonly kind?: string | undefined }[] } | undefined,
  records: readonly Signed[] = [],
  prior = WRITE_VERSION,
): number => {
  if (prior >= RESTORE_FORMAT || records.some((record) => parseRecord(record)?.type === "readmit"))
    return RESTORE_FORMAT;
  return prior === CLIENT_FORMAT || index?.members.some((member) => member.kind === "client") === true
    ? CLIENT_FORMAT
    : WRITE_VERSION;
};

/** A new mesh's first file, in the format this build writes today. */
export const newMeshFile = (meshId: string, records: readonly Signed[], selfN: number): MeshFile => ({
  version: WRITE_VERSION,
  meshId,
  generation: 1,
  selfN,
  records,
  dangling: [],
  local: {},
  notices: {},
  readOnlyUntil: null,
  index: undefined,
});

export const meshFileJson = (file: MeshFile) => ({
  version: writeVersionOf(file.index, file.records, file.version),
  meshId: file.meshId,
  generation: file.generation,
  self: { n: file.selfN },
  records: file.records,
  dangling: file.dangling,
  local: file.local,
  notices: file.notices,
  readOnlyUntil: file.readOnlyUntil,
  ...(file.index === undefined ? {} : { index: file.index }),
});
