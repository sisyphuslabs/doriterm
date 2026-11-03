import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Mesh } from "./mesh.ts";
import type { MeshHost } from "./mesh-host.ts";

export interface SignedRecord {
  readonly body: string;
  readonly sig: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export async function statusOf(host: MeshHost): Promise<Record<string, unknown>> {
  const run = await host.cli("mesh", "status", "--json");
  const parsed: unknown = run.exit === 0 ? JSON.parse(run.stdout) : undefined;
  if (!isRecord(parsed)) throw new Error(`mesh status --json on ${host.name} failed: ${run.stderr}${run.stdout}`);
  return parsed;
}

/** The members of this host's view as {hostId, name}, from `mesh status --json` (`members[]`, design section 8.6). */
export async function viewOf(host: MeshHost): Promise<readonly { readonly hostId: string; readonly name: string }[]> {
  const members = (await statusOf(host))["members"];
  if (!Array.isArray(members)) throw new Error(`mesh status on ${host.name} has no members`);
  return members
    .flatMap((member: unknown) =>
      isRecord(member) && typeof member["hostId"] === "string" && typeof member["name"] === "string"
        ? [{ hostId: member["hostId"], name: member["name"] }]
        : [],
    )
    .toSorted((x, y) => x.hostId.localeCompare(y.hostId));
}

/** The records this host stores (`mesh.json`, design section 10.1), for tests that replay or build on them. */
export function storedRecords(host: MeshHost): readonly SignedRecord[] {
  const file: unknown = JSON.parse(readFileSync(join(host.stateDir, "mesh.json"), "utf8"));
  const records = isRecord(file) ? file["records"] : undefined;
  if (!Array.isArray(records)) throw new Error(`no records in ${host.name}'s mesh.json`);
  return records.flatMap((entry: unknown) =>
    isRecord(entry) && typeof entry["body"] === "string" && typeof entry["sig"] === "string"
      ? [{ body: entry["body"], sig: entry["sig"] }]
      : [],
  );
}

/** The id of the mesh this host is in, from its `mesh.json`. */
export function meshIdOf(host: MeshHost): string {
  const file: unknown = JSON.parse(readFileSync(join(host.stateDir, "mesh.json"), "utf8"));
  const id = isRecord(file) ? file["meshId"] : undefined;
  if (typeof id !== "string") throw new Error(`${host.name} has no meshId`);
  return id;
}

/** The host ids each running host lists as a machine in its own core, by host name. */
export async function machineIds(mesh: Mesh, name: string): Promise<readonly string[]> {
  const machines = (await (await mesh.core(name)).call("machine.list")).machines;
  return machines.map((machine) => machine.id).toSorted();
}
