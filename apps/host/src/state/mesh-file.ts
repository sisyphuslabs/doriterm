import type { Signed } from "@doriface/mesh";
import type { IndexData, MemberEntry, RevokedEntry } from "../mesh/authorize-index.ts";
import { isRecord } from "./files.ts";

export const MESH_FILE = "mesh.json";
const VERSION = 2;

/**
 * `mesh.json` (section 10.1). `records` is the only source of trust; `index` is what `authorize` reads, derived from
 * the records at this `generation` by the writer, and `local`, `notices` and `readOnlyUntil` are display state.
 */
export interface MeshFile {
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

function memberEntry(value: unknown): MemberEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { signPub, hostId, noisePub, devicePub, name, hcId } = value;
  if (typeof signPub !== "string" || typeof hostId !== "string" || typeof noisePub !== "string") return undefined;
  if (typeof name !== "string" || typeof hcId !== "string") return undefined;
  if (devicePub !== undefined && typeof devicePub !== "string") return undefined;
  return { signPub, hostId, noisePub, devicePub, name, hcId };
}

function revokedEntry(value: unknown): RevokedEntry | undefined {
  if (!isRecord(value)) return undefined;
  const { signPub, hostId, keys } = value;
  return typeof signPub === "string" && typeof hostId === "string" && strings(keys)
    ? { signPub, hostId, keys }
    : undefined;
}

function all<T>(value: unknown, item: (entry: unknown) => T | undefined): readonly T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map(item);
  return items.every((entry) => entry !== undefined) ? items.filter((entry) => entry !== undefined) : undefined;
}

/** The persisted index, or undefined when it is missing or malformed (the host rebuilds it at start). */
function indexData(value: unknown): IndexData | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value["generation"])) return undefined;
  const members = all(value["members"], memberEntry);
  const overCap = all(value["overCap"], memberEntry);
  const revoked = all(value["revoked"], revokedEntry);
  const superseded = value["superseded"];
  if (members === undefined || overCap === undefined || revoked === undefined || !strings(superseded)) return undefined;
  return { generation: Number(value["generation"]), members, overCap, revoked, superseded };
}

const objectOr = (value: unknown): Readonly<Record<string, unknown>> => (isRecord(value) ? value : {});

export function parseMeshFile(value: unknown): MeshFile {
  if (!isRecord(value) || value["version"] !== VERSION) throw new Error(`${MESH_FILE}: unsupported format`);
  const { meshId, generation, self, readOnlyUntil } = value;
  const selfN = isRecord(self) ? self["n"] : undefined;
  if (typeof meshId !== "string" || !Number.isSafeInteger(generation) || !Number.isSafeInteger(selfN)) {
    throw new Error(`${MESH_FILE}: malformed`);
  }
  return {
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

export const meshFileJson = (file: MeshFile) => ({
  version: VERSION,
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
