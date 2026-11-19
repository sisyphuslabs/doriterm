import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface SkillFile {
  /** The file's path inside the skill directory, `/`-separated (`references/hc.md`). */
  readonly path: string;
  readonly text: string;
}

const SOURCE = join(import.meta.dir, "..", "..", "..", "..", "skills", "doriterm");

function walk(root: string, dir: string, into: SkillFile[]): void {
  for (const name of readdirSync(dir).toSorted()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(root, path, into);
    else into.push({ path: relative(root, path).split(sep).join("/"), text: readFileSync(path, "utf8") });
  }
}

/**
 * Every file under `skills/doriterm`, read when the host is built: imported `with { type: "macro" }`, so a compiled
 * host (the release binaries and the desktop app's) carries the files it was built with, and a checkout run reads the
 * checkout's. A checkout without the directory carries none.
 */
export function readSkillSource(source: string = SOURCE): SkillFile[] {
  const files: SkillFile[] = [];
  try {
    walk(source, source, files);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return files;
}
