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
 * checkout's. A source without SKILL.md fails the build.
 */
export function readSkillSource(source: string = SOURCE): SkillFile[] {
  const files: SkillFile[] = [];
  try {
    walk(source, source, files);
  } catch (error) {
    // A build without the skill would ship a host that cannot install it: refuse to build instead.
    throw new Error(`the agent skill the host carries is missing: no skills/doriterm at ${source}`, { cause: error });
  }
  if (!files.some((file) => file.path === "SKILL.md")) throw new Error(`skills/doriterm at ${source} has no SKILL.md`);
  return files;
}
