import { programName } from "@doriface/protocol";
import type { Session } from "./attention.ts";

/**
 * The agents a row can be told apart as, by the key herdr-app's program table gives each (its `defaults/programs.json`),
 * so the two apps name the same agent the same way.
 */
export const AGENT_KINDS = [
  "claude",
  "codex",
  "cursor",
  "copilot",
  "gemini",
  "grok",
  "opencode",
  "amp",
  "kimi",
  "antigravity",
  "omo",
  "omp",
  "droid",
  "qwen",
  "qoder",
  "kiro",
] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];

/**
 * Other names an agent goes by, as that table's `match` lists have them. `agent` is here on purpose: the generic name
 * yields to an alias, since Cursor's CLI process is literally named `agent`.
 */
const ALIASES: Readonly<Record<string, AgentKind>> = {
  "claude-code": "claude",
  "cursor-agent": "cursor",
  agent: "cursor",
  "github-copilot": "copilot",
  "grok-build": "grok",
  "kimi-code": "kimi",
  kimicodecli: "kimi",
  "oh-my-pi": "omp",
  agy: "antigravity",
  qodercli: "qoder",
  "kiro-cli": "kiro",
};

const KINDS: ReadonlySet<string> = new Set(AGENT_KINDS);
const isKind = (name: string): name is AgentKind => KINDS.has(name);

/** The kind a name stands for, any case; none for a name that is no known agent's. */
function kindOf(name: string): AgentKind | null {
  const key = name.toLowerCase();
  if (isKind(key)) return key;
  return Object.hasOwn(ALIASES, key) ? (ALIASES[key] ?? null) : null;
}

/** Programs that run a script: the script names the agent, not the interpreter. */
const INTERPRETERS: ReadonlySet<string> = new Set(["node", "nodejs", "bun", "deno", "python", "python3", "tsx"]);
/** Shells whose `-c` command names the agent. */
const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const SCRIPT_EXTENSION = /\.(?:[cm]?js|ts|py)$/iu;

/** A script as the agent it is: its file's name, else the nearest folder of the package tree it is installed in. */
function scriptKind(path: string): AgentKind | null {
  const parts = path.split(/[/\\]/u).filter((part) => part !== "");
  const named = kindOf((parts.at(-1) ?? "").replace(SCRIPT_EXTENSION, ""));
  if (named !== null) return named;
  const tree = parts.lastIndexOf("node_modules");
  if (tree === -1) return null;
  for (const part of parts.slice(tree + 1, -1).toReversed()) {
    const kind = kindOf(part);
    if (kind !== null) return kind;
  }
  return null;
}

/** A word a command line starts with that is not its program: `env`, `exec` or a `NAME=value` before it. */
function skipped(word: string): boolean {
  return word === "env" || word === "exec" || ASSIGNMENT.test(word);
}

/** A command line from its program on, past any `env`, `exec` and `NAME=value` before it; empty when none is left. */
export function commandWords(argv: readonly string[]): readonly string[] {
  const start = argv.findIndex((word) => !skipped(word));
  return start === -1 ? [] : argv.slice(start);
}

/** The agent a command line runs, read past an `env`, a shell's `-c` and an interpreter, each at most once deep. */
function commandKind(argv: readonly string[], depth = 0): AgentKind | null {
  const [first, ...rest] = commandWords(argv);
  if (first === undefined) return null;
  const name = programName(first).toLowerCase();
  const direct = kindOf(name);
  if (direct !== null || depth > 1) return direct;
  if (INTERPRETERS.has(name)) {
    const script = rest.find((word) => !word.startsWith("-") && word !== "run");
    return script === undefined ? null : scriptKind(script);
  }
  if (SHELLS.has(name)) {
    const flag = rest.findIndex((word) => /^-[a-z]*c$/u.test(word));
    const command = flag === -1 ? undefined : rest[flag + 1];
    return command === undefined ? null : commandKind(command.split(/\s+/u).filter(Boolean), depth + 1);
  }
  return null;
}

/**
 * The agent a terminal runs, as a stable key: its own OSC 7501 report (`status.app`) first, then the program in front,
 * then the one the terminal started. None for a shell, another program, or an agent this app has no name for.
 */
export function agentKind(terminal: Session): AgentKind | null {
  const reported = kindOf(terminal.status?.app ?? "");
  if (reported !== null) return reported;
  const front = terminal.foreground;
  const argv = front === undefined || front === null ? [] : front.argv.length > 0 ? front.argv : [front.name];
  return commandKind(argv.length > 0 ? argv : terminal.argv);
}
