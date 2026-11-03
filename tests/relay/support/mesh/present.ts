import { type Capability, detect, gate, loadMeshLib, type Present } from "./capabilities.ts";
import { type RecordKit, recordKit } from "./records.ts";

/** Detected once per test run; every scenario file imports it. */
export const present: Present = await detect();

const lib = await loadMeshLib();

/** Signing and hashing from `packages/mesh`; only defined when that package is on this branch. */
export const kit: RecordKit | undefined = lib === undefined ? undefined : recordKit(lib);

export function needKit(): RecordKit {
  if (kit === undefined) throw new Error("packages/mesh is not on this branch");
  return kit;
}

/** Whether a scenario's capabilities are all here; the reason is printed so a skipped scenario is never silent. */
export function runs(id: string, needs: readonly Capability[]): boolean {
  const verdict = gate(present, needs);
  console.log(verdict.run ? `RUNS  ${id}` : `GATED ${id}: ${verdict.why}`);
  return verdict.run;
}
