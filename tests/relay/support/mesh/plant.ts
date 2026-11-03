import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MeshHost } from "./mesh-host.ts";
import type { SignedRecord } from "./status.ts";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * Puts the attacker's records into a stopped host's own `mesh.json` (section 10.1), as a thief holding its keys would
 * have signed them there: appended to `records`, `self.n` raised to its highest own counter so the host is not
 * behind its own records, `generation` bumped, and the derived authorize `index` dropped for the host to rebuild.
 * Started again, the host serves them like any record it holds.
 */
export function plantRecords(host: MeshHost, signPub: string, records: readonly SignedRecord[]): void {
  const path = join(host.stateDir, "mesh.json");
  const file: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(file) || !Array.isArray(file["records"]) || !isRecord(file["self"])) {
    throw new Error(`${host.name}'s mesh.json has no records`);
  }
  const own = records.flatMap((record) => {
    const body: unknown = JSON.parse(record.body);
    return isRecord(body) && body["by"] === signPub && typeof body["n"] === "number" ? [body["n"]] : [];
  });
  const selfN = typeof file["self"]["n"] === "number" ? file["self"]["n"] : 0;
  const generation = typeof file["generation"] === "number" ? file["generation"] : 0;
  const { index: _derived, ...kept } = file;
  const planted = {
    ...kept,
    generation: generation + 1,
    self: { ...file["self"], n: Math.max(selfN, ...own) },
    records: [...file["records"], ...records],
  };
  writeFileSync(path, `${JSON.stringify(planted)}\n`, { mode: 0o600 });
}
