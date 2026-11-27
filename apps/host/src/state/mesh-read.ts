import { readJson } from "./files.ts";
import { type MeshFile, parseMeshFile } from "./mesh-file.ts";

/** What is on disk at mesh.json: nothing, a mesh, or a file that cannot be read or parsed (#2951). */
export type MeshFileState =
  | { readonly kind: "none" }
  | { readonly kind: "file"; readonly file: MeshFile }
  | { readonly kind: "unreadable"; readonly reason: string };

export function readMeshFile(path: string): MeshFileState {
  try {
    const value = readJson(path);
    return value === undefined ? { kind: "none" } : { kind: "file", file: parseMeshFile(value) };
  } catch (error) {
    return { kind: "unreadable", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** What a join, an offer or `mesh status` says about a mesh.json nobody can read. */
export const unreadableMesh = (path: string, reason: string): string =>
  `mesh state unreadable: ${path} (${reason}); fix or remove it`;
