import { describe, test } from "bun:test";
import { type Capability, detect, gate, isRequired, type Present, ROOT } from "./capabilities.ts";
import { loadMeshLib, type MeshLib } from "./mesh-lib.ts";

/** Detected once per test run; every scenario file imports it. */
export const present: Present = await detect();

export const REQUIRED = isRequired(ROOT, process.env["DORIFACE_MESH_E2E"]);

const loaded = await loadMeshLib(ROOT);

/** Signing and hashing from `packages/mesh`; a scenario that needs it does not run unless the records probe passed. */
export function needLib(): MeshLib {
  if (loaded === undefined || typeof loaded === "string") {
    throw new Error(loaded ?? "packages/mesh is not on this branch");
  }
  return loaded;
}

/**
 * A scenario that needs these capabilities. It runs when they all work; it is skipped, with the reason printed, only
 * while the mesh stack is absent and nothing requires it; otherwise it is one failing test naming what does not work.
 */
export function scenario(title: string, needs: readonly Capability[], body: () => void): void {
  const verdict = gate(present, needs, REQUIRED);
  if (verdict.kind === "run") return describe(title, body);
  console.log(`${verdict.kind === "skip" ? "GATED" : "FAILS"} ${title}: ${verdict.why}`);
  if (verdict.kind === "skip") return describe.skip(title, body);
  return describe(title, () => {
    test("the capabilities this scenario needs work", () => {
      throw new Error(verdict.why);
    });
  });
}
