import type { SkillState, SkillStatus } from "@doriface/protocol";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { requestControl } from "../control.ts";
import {
  type DirResult,
  installSkill,
  NoBundledSkill,
  skillStatus,
  type SkillBundle,
  uninstallSkill,
} from "../skill/agent-skill.ts";
// The one module that imports the bundle: Bun 1.4.4 leaves a macro call unreplaced in a module two others import.
import { BUNDLED_SKILL } from "../skill/bundled.ts";
import { type AgentSkill, agentSkill } from "../skill/skill-host.ts";
import { skillTargets } from "../skill/skill-targets.ts";
import { defaultStateDir } from "../state/files.ts";

export const SKILL_USAGE = `usage: doriface-host skill install [--dir <skills dir>]...
       doriface-host skill status [--json] [--dir <skills dir>]...
       doriface-host skill uninstall [--dir <skills dir>]...

  Installs the Doriterm agent skill this host carries into the agent skill directories found here: ~/.agents/skills
  (made when absent) and ~/.claude/skills when Claude Code is set up, or each --dir given. A doriterm skill directory
  the host did not write is reported and never overwritten or removed.

  --dir <dir>          an agent skill directory to use instead of the ones found (repeatable)
  --json               status: print the status as JSON
  --state-dir <dir>    the running host to tell, so the app shows the change (default $DORIFACE_HOST_STATE_DIR)`;

export { BUNDLED_SKILL };

/** The agent skill a running host manages: the bundled one, in the directories found under this user's home. */
export const hostAgentSkill = (): AgentSkill => agentSkill(BUNDLED_SKILL, () => skillTargets(homedir()));

export interface SkillCommandEnv {
  readonly bundle?: SkillBundle;
  readonly home?: string;
  readonly now?: () => Date;
  /** Tells a running host the skill changed; resolves undefined when none runs. */
  readonly notify?: (stateDir: string) => Promise<unknown>;
}

const STATE_WORDS: Readonly<Record<SkillState, string>> = {
  installed: "installed",
  outdated: "outdated (written by an older host)",
  missing: "not installed",
  foreign: "not managed by Doriterm (a doriterm skill this host did not write; left alone)",
};

function statusLines(status: SkillStatus): string {
  const head = status.bundled === null ? "this host build carries no agent skill" : `bundled skill v${status.bundled}`;
  const dirs = status.dirs.map(({ dir, state, version }) => {
    const word = STATE_WORDS[state];
    return `  ${dir}/doriterm: ${word}${version === undefined || state === "foreign" ? "" : ` (v${version})`}`;
  });
  return `${[head, ...dirs].join("\n")}\n`;
}

/** One line per directory; answers the exit code: 1 when any directory failed. */
function report<A extends string>(
  results: readonly DirResult<A | "failed">[],
  words: Readonly<Record<A, string>>,
  out: (text: string) => void,
): number {
  for (const { dir, action, error } of results) {
    out(`${dir}/doriterm: ${action === "failed" ? `failed: ${error ?? "unknown error"}` : words[action as A]}\n`);
  }
  return results.some((result) => result.action === "failed") ? 1 : 0;
}

const notifyHost = (stateDir: string): Promise<unknown> =>
  requestControl(stateDir, { op: "skill-changed" }).catch(() => undefined);

/** `doriface-host skill install|status|uninstall`; answers the exit code. */
export async function skillCommand(
  args: readonly string[],
  out: (text: string) => void,
  env: SkillCommandEnv,
): Promise<number> {
  const [action, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    strict: true,
    allowPositionals: false,
    options: {
      dir: { type: "string", multiple: true, default: [] },
      json: { type: "boolean", default: false },
      "state-dir": { type: "string" },
    },
  });
  const bundle = env.bundle ?? BUNDLED_SKILL;
  const targets = skillTargets(env.home ?? homedir(), values.dir);
  const now = env.now ?? (() => new Date());
  const notify = (): Promise<unknown> => (env.notify ?? notifyHost)(values["state-dir"] ?? defaultStateDir());
  switch (action) {
    case "status": {
      const status = await skillStatus(bundle, targets);
      out(values.json ? `${JSON.stringify(status, null, 2)}\n` : statusLines(status));
      return 0;
    }
    case "install": {
      try {
        const results = await installSkill(bundle, targets, now);
        return report(
          results,
          {
            written: `installed v${bundle.version}`,
            updated: `updated to v${bundle.version}`,
            unchanged: "already current",
            foreign: "left alone: a doriterm skill this host did not write is there",
          },
          out,
        );
      } catch (error) {
        if (!(error instanceof NoBundledSkill)) throw error;
        out(`${error.message}; nothing was installed\n`);
        return 1;
      } finally {
        await notify();
      }
    }
    case "uninstall":
      try {
        return report(
          await uninstallSkill(bundle, targets),
          { removed: "removed", missing: "not installed", foreign: "left alone: this host did not write it" },
          out,
        );
      } finally {
        await notify();
      }
    default:
      throw new Error(action === undefined ? "skill wants install, status or uninstall" : `unknown skill ${action}`);
  }
}
