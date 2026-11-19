import type { SkillStatus } from "@doriface/protocol";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { requestControl } from "../control.ts";
import { installSkill, NoBundledSkill, skillStatus, type SkillBundle, uninstallSkill } from "../skill/agent-skill.ts";
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

export interface SkillCommandEnv {
  readonly bundle: SkillBundle;
  readonly home?: string;
  readonly now?: () => Date;
  /** Tells a running host the skill changed; resolves undefined when none runs. */
  readonly notify?: (stateDir: string) => Promise<unknown>;
}

const STATE_WORDS: Readonly<Record<string, string>> = {
  installed: "installed",
  outdated: "outdated (written by an older host)",
  missing: "not installed",
  foreign: "not managed by Doriterm (a doriterm skill this host did not write; left alone)",
};

function statusLines(status: SkillStatus): string {
  const head = status.bundled === null ? "this host build carries no agent skill" : `bundled skill v${status.bundled}`;
  const dirs = status.dirs.map(({ dir, state, version }) => {
    const word = STATE_WORDS[state] ?? state;
    return `  ${dir}/doriterm: ${word}${version === undefined || state === "foreign" ? "" : ` (v${version})`}`;
  });
  return `${[head, ...dirs].join("\n")}\n`;
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
  const targets = skillTargets(env.home ?? homedir(), values.dir);
  const now = env.now ?? (() => new Date());
  const notify = (): Promise<unknown> => (env.notify ?? notifyHost)(values["state-dir"] ?? defaultStateDir());
  switch (action) {
    case "status": {
      const status = await skillStatus(env.bundle, targets);
      out(values.json ? `${JSON.stringify(status, null, 2)}\n` : statusLines(status));
      return 0;
    }
    case "install": {
      let results;
      try {
        results = await installSkill(env.bundle, targets, now);
      } catch (error) {
        if (!(error instanceof NoBundledSkill)) throw error;
        out(`${error.message}; nothing was installed\n`);
        return 1;
      }
      await notify();
      for (const { dir, action: done } of results) {
        const word = {
          written: `installed v${env.bundle.version}`,
          updated: `updated to v${env.bundle.version}`,
          unchanged: "already current",
          foreign: "left alone: a doriterm skill this host did not write is there",
        }[done];
        out(`${dir}/doriterm: ${word}\n`);
      }
      return 0;
    }
    case "uninstall": {
      const results = await uninstallSkill(env.bundle, targets);
      await notify();
      for (const { dir, action: done } of results) {
        const word = {
          removed: "removed",
          missing: "not installed",
          foreign: "left alone: this host did not write it",
        }[done];
        out(`${dir}/doriterm: ${word}\n`);
      }
      return 0;
    }
    default:
      throw new Error(action === undefined ? "skill wants install, status or uninstall" : `unknown skill ${action}`);
  }
}
