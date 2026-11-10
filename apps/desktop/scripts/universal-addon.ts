const UNIVERSAL = ["arm64", "x86_64"] as const;

/** What `lipo -archs <file>` reported: how lipo exited and what it printed. */
export interface LipoResult {
  readonly exitCode: number | null;
  readonly stdout: string;
}

/** Answers what `lipo -archs <file>` says. A parameter so a test can answer without the real lipo macOS has (#1228). */
export type Lipo = (file: string) => LipoResult;

const realLipo: Lipo = (file) => {
  const run = Bun.spawnSync(["lipo", "-archs", file], { stderr: "inherit" });
  return { exitCode: run.exitCode, stdout: run.stdout.toString() };
};

/**
 * The slices a universal macOS build needs that `lipo -archs` did not print. Each is matched by its exact name, so an
 * `arm64e` slice is not taken for `arm64` (#1117).
 */
export function missingSlices(archs: string): string[] {
  const held = new Set(archs.split(/\s+/));
  return UNIVERSAL.filter((slice) => !held.has(slice));
}

/**
 * Fails unless the Mach-O file holds both slices, printing what it holds. A lipo that did not run is reported with its
 * exit code, so a missing or broken tool fails the build instead of passing it silently.
 */
export function checkUniversal(file: string, lipo: Lipo = realLipo): void {
  const result = lipo(file);
  if (result.exitCode !== 0) throw new Error(`lipo -archs ${file} exited ${String(result.exitCode)}`);
  const archs = result.stdout;
  console.log(`${file}: ${archs.trim()}`);
  const missing = missingSlices(archs);
  if (missing.length > 0) throw new Error(`${file} is not universal: it lacks ${missing.join(", ")}`);
}

// `bun scripts/universal-addon.ts <file>`: fails unless the Mach-O file holds both slices (CI, desktop-macos).
if (import.meta.main) {
  const file = Bun.argv[2];
  if (file === undefined) throw new Error("usage: bun scripts/universal-addon.ts <file>");
  checkUniversal(file);
}
