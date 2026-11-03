import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SignedRecord } from "./status.ts";

/** What the scenarios use from `packages/mesh` (PR 2, design section 11 "API"). */
export interface MeshLib {
  signRecord(body: object, signSecret: Uint8Array): SignedRecord;
  signCard(card: object, signSecret: Uint8Array): SignedRecord;
  hashOf(record: SignedRecord): string;
  meshIdOf(found: SignedRecord): string;
  verifyCard(card: SignedRecord): object | undefined;
  viewOf(set: readonly SignedRecord[]): { readonly members: ReadonlySet<string> };
}

const API = ["signRecord", "signCard", "hashOf", "meshIdOf", "verifyCard", "viewOf"] as const;

const isMeshLib = (value: unknown): value is MeshLib =>
  typeof value === "object" &&
  value !== null &&
  API.every((name) => name in value && typeof Reflect.get(value, name) === "function");

export const meshEntry = (root: string): string => join(root, "packages", "mesh", "src", "index.ts");

/**
 * The package, loaded by path so this file builds on a branch without it. Absent: no `packages/mesh` at all. A
 * string: the package is there but does not export the API, which is a broken capability, never a missing one.
 */
export async function loadMeshLib(root: string): Promise<MeshLib | string | undefined> {
  const entry = meshEntry(root);
  if (!existsSync(entry)) return undefined;
  const loaded: unknown = await import(entry).catch((error: unknown) => String(error));
  if (typeof loaded === "string") return `packages/mesh does not load: ${loaded}`;
  if (isMeshLib(loaded)) return loaded;
  const absent = API.filter((name) => typeof loaded !== "object" || loaded === null || !(name in loaded));
  return `packages/mesh does not export ${absent.join(", ") || "callable " + API.join(", ")}`;
}
