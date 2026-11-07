const UNIVERSAL = ["arm64", "x86_64"] as const;

/**
 * The slices a universal macOS build needs that `lipo -archs` did not print. Each is matched by its exact name, so an
 * `arm64e` slice is not taken for `arm64` (#1117).
 */
export function missingSlices(archs: string): string[] {
  const held = new Set(archs.split(/\s+/));
  return UNIVERSAL.filter((slice) => !held.has(slice));
}

// `bun scripts/universal-addon.ts <file>`: fails unless the Mach-O file holds both slices (CI, desktop-macos).
if (import.meta.main) {
  const file = Bun.argv[2];
  if (file === undefined) throw new Error("usage: bun scripts/universal-addon.ts <file>");
  const lipo = Bun.spawnSync(["lipo", "-archs", file], { stderr: "inherit" });
  if (lipo.exitCode !== 0) throw new Error(`lipo -archs ${file} exited ${String(lipo.exitCode)}`);
  const archs = lipo.stdout.toString();
  console.log(`${file}: ${archs.trim()}`);
  const missing = missingSlices(archs);
  if (missing.length > 0) throw new Error(`${file} is not universal: it lacks ${missing.join(", ")}`);
}
