import { existsSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { SkillTarget } from "./agent-skill.ts";

const shownFrom = (home: string, path: string): string =>
  path === home ? "~" : path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length).split(sep).join("/")}` : path;

/**
 * The agent skill directories the skill goes into: the `dirs` given (`--dir`), else `~/.agents/skills` (which Codex,
 * OpenCode and other agents read; made when absent) and `~/.claude/skills` when Claude Code is set up (`~/.claude`).
 */
export function skillTargets(
  home: string,
  dirs: readonly string[] = [],
  present: (path: string) => boolean = existsSync,
): readonly SkillTarget[] {
  const paths =
    dirs.length > 0
      ? dirs.map((dir) => (isAbsolute(dir) ? dir : resolve(dir)))
      : [join(home, ".agents", "skills"), ...(present(join(home, ".claude")) ? [join(home, ".claude", "skills")] : [])];
  return [...new Set(paths)].map((path) => ({ path, shown: shownFrom(home, path) }));
}
