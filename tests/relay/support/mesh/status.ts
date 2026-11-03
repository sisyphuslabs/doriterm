import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Mesh } from "./mesh.ts";
import type { MeshHost } from "./mesh-host.ts";

export interface SignedRecord {
  readonly body: string;
  readonly sig: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

export interface Member {
  readonly hostId: string;
  readonly name: string;
  /** `witnessPool` (section 6.1): who could witness a revoke of this member written here. */
  readonly pool: readonly string[] | undefined;
}

/** `mesh status --json` (the `doriface-mesh` document, PR 7): the fields the scenarios assert. */
export interface Status {
  /** `ok` or `stuck`. */
  readonly sync: string;
  readonly members: readonly Member[];
  /** `stuck[].kind`, e.g. `removed_undecidable` (section 3.7). */
  readonly stuck: readonly string[];
}

const memberOf = (value: unknown): readonly Member[] => {
  if (!isRecord(value) || typeof value["hostId"] !== "string" || typeof value["name"] !== "string") return [];
  const witnessPool = value["witnessPool"];
  const pool = Array.isArray(witnessPool) ? witnessPool.map(String) : undefined;
  return [{ hostId: value["hostId"], name: value["name"], pool }];
};

export async function statusOf(host: MeshHost): Promise<Status> {
  const run = await host.cli("mesh", "status", "--json");
  const parsed: unknown = run.exit === 0 ? JSON.parse(run.stdout) : undefined;
  if (!isRecord(parsed) || !Array.isArray(parsed["members"])) {
    throw new Error(`mesh status --json on ${host.name} failed: ${run.stderr}${run.stdout}`);
  }
  return {
    sync: String(parsed["sync"]),
    members: parsed["members"].flatMap(memberOf).toSorted((x, y) => x.hostId.localeCompare(y.hostId)),
    stuck: listOf(parsed["stuck"]).flatMap((entry) =>
      isRecord(entry) && typeof entry["kind"] === "string" ? [entry["kind"]] : [],
    ),
  };
}

/** The members of this host's view as {hostId, name}. */
export async function viewOf(host: MeshHost): Promise<readonly Member[]> {
  return (await statusOf(host)).members;
}

interface MeshFile {
  readonly meshId: string;
  readonly records: readonly SignedRecord[];
  readonly dangling: readonly SignedRecord[];
}

const signedList = (value: unknown): readonly SignedRecord[] =>
  listOf(value).flatMap((entry) =>
    isRecord(entry) && typeof entry["body"] === "string" && typeof entry["sig"] === "string"
      ? [{ body: entry["body"], sig: entry["sig"] }]
      : [],
  );

/** `mesh.json` (section 10.1): the stored set, and the dangling pool the door holds records in. */
export function meshFileOf(host: MeshHost): MeshFile {
  const file: unknown = JSON.parse(readFileSync(join(host.stateDir, "mesh.json"), "utf8"));
  if (!isRecord(file) || typeof file["meshId"] !== "string") throw new Error(`${host.name} has no mesh.json`);
  return { meshId: file["meshId"], records: signedList(file["records"]), dangling: signedList(file["dangling"]) };
}

export const storedRecords = (host: MeshHost): readonly SignedRecord[] => meshFileOf(host).records;
export const meshIdOf = (host: MeshHost): string => meshFileOf(host).meshId;

/** The host ids each running host lists as a machine in its own core, by host name. */
export async function machineIds(mesh: Mesh, name: string): Promise<readonly string[]> {
  const machines = (await (await mesh.core(name)).call("machine.list")).machines;
  return machines.map((machine) => machine.id).toSorted();
}
