import type { HcConnection } from "@doriface/client";
import type { Terminal } from "@doriface/protocol";

/** One of OmO's slash commands, as its own `get_commands` lists it. */
export interface SlashCommand {
  readonly name: string;
  readonly description: string;
}

/** Runs a program on a machine (hc's `machine.exec`); the one way this module reaches OmO. */
export type ExecOn = Pick<HcConnection, "call">;

/** The request OmO's RPC mode answers with its command list (`omo --mode rpc`, senpi's `get_commands`). */
const REQUEST = JSON.stringify({ id: "doriterm-commands", type: "get_commands" });

/**
 * Runs OmO in RPC mode and hands back its `get_commands` reply. OmO shuts down as soon as its stdin ends, possibly before
 * it answered, so the request goes in through a FIFO that stays open until the reply line is read; closing it then
 * ends OmO, which the script waits for.
 */
export const PROBE = [
  `d=$(mktemp -d) || exit 1`,
  // Removed however the script ends, a timeout's TERM included.
  `trap 'rm -rf "$d"' EXIT`,
  `trap 'exit 143' TERM INT HUP`,
  `mkfifo "$d/in" "$d/out" || exit 1`,
  `"$DORITERM_OMO" --mode rpc --no-session <"$d/in" >"$d/out" 2>/dev/null &`,
  `exec 4>"$d/in" 5<"$d/out"`,
  `printf '%s\\n' "$DORITERM_OMO_REQUEST" >&4`,
  `while IFS= read -r line <&5; do case $line in *'"command":"get_commands"'*) printf '%s\\n' "$line"; break ;; esac; done`,
  `exec 4>&- 5<&-`,
  `wait`,
].join("\n");

/** How long a listing is kept before OmO is asked again, so an upgrade or a new extension shows up. */
export const LISTING_TTL_MS = 5 * 60_000;

/** Programs that run OmO as a script: their first argument is OmO's path. */
const INTERPRETERS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "node", "bun", "deno"]);

/** How long a listing may take before it counts as failed; OmO starts its session first, about two seconds. */
const LIST_TIMEOUT_S = 30;

const programName = (path: string): string =>
  (path.split(/[/\\]/).at(-1) ?? path).replace(/^-+/, "").replace(/\.exe$/i, "");
const isOmo = (path: string): boolean => programName(path) === "omo";

/**
 * The OmO program a terminal runs in front of its shell, as it was started (a path, or `omo` found on the PATH); null
 * when what runs there is not OmO.
 */
export function omoProgram(terminal: Terminal): string | null {
  const front = terminal.foreground;
  if (front === undefined || front === null) return null;
  const [first = "", second = ""] = front.argv;
  if (isOmo(first)) return first;
  // OmO as a script runs under its interpreter (`sh /path/omo`, `node /path/omo`); any later argument is a file the
  // program works on (`vim omo`, `less ./omo`), never OmO.
  if (INTERPRETERS.has(programName(first)) && isOmo(second)) return second;
  return isOmo(front.name) && !INTERPRETERS.has(programName(first)) ? "omo" : null;
}

const utf8 = (base64: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));

/**
 * The slash commands in OmO's RPC output: the `get_commands` response among its event lines, skills (`$` syntax) left
 * out. Throws when the output holds no such response, so a broken listing reads as a failure, not as no commands.
 */
export function parseCommands(stdout: string): readonly SlashCommand[] {
  for (const line of stdout.split("\n")) {
    if (!line.includes('"get_commands"')) continue;
    let reply: unknown;
    try {
      reply = JSON.parse(line);
    } catch {
      continue;
    }
    const data = (reply as { command?: unknown; data?: { commands?: unknown } }).data;
    if ((reply as { command?: unknown }).command !== "get_commands" || !Array.isArray(data?.commands)) continue;
    const commands: SlashCommand[] = [];
    for (const each of data.commands as { name?: unknown; description?: unknown; syntax?: unknown }[]) {
      if (typeof each.name !== "string" || each.name === "" || (each.syntax ?? "slash") !== "slash") continue;
      commands.push({ name: each.name, description: typeof each.description === "string" ? each.description : "" });
    }
    return commands;
  }
  throw new Error("OmO gave no command list");
}

/**
 * Asks OmO itself for its commands on the machine the terminal runs on: the same program in the terminal's directory,
 * in RPC mode with no session saved, one `get_commands` on its stdin.
 */
export async function listCommands(
  exec: ExecOn,
  where: { readonly machine: string | undefined; readonly program: string; readonly cwd: string },
): Promise<readonly SlashCommand[]> {
  const result = await exec.call("machine.exec", {
    line: PROBE,
    env: { DORITERM_OMO: where.program, DORITERM_OMO_REQUEST: REQUEST },
    cwd: where.cwd,
    timeout: LIST_TIMEOUT_S,
    ...(where.machine === undefined ? {} : { on: where.machine }),
  });
  return parseCommands(utf8(result.stdout));
}

/**
 * Listings by machine, program and directory (OmO loads a project's own extensions and prompts from it), each kept for
 * `ttlMs` by `now`: one OmO start per place, however many terminals ask.
 */
export function commandCache({
  list = listCommands,
  now = Date.now,
  ttlMs = LISTING_TTL_MS,
}: { list?: typeof listCommands; now?: () => number; ttlMs?: number } = {}): (
  exec: ExecOn,
  where: Parameters<typeof listCommands>[1],
) => Promise<readonly SlashCommand[]> {
  const kept = new Map<string, { readonly at: number; readonly asked: Promise<readonly SlashCommand[]> }>();
  return (exec, where) => {
    const key = `${where.machine ?? ""}\n${where.program}\n${where.cwd}`;
    const known = kept.get(key);
    if (known !== undefined && now() - known.at < ttlMs) return known.asked;
    const asked = list(exec, where);
    const entry = { at: now(), asked };
    kept.set(key, entry);
    // A failed listing is asked again next time, not remembered.
    asked.catch(() => {
      if (kept.get(key) === entry) kept.delete(key);
    });
    return asked;
  };
}

/**
 * The commands a typed `/word` names: the one named exactly that first, then those starting with it, then those
 * containing it, each in OmO's order.
 */
export function matchCommands(commands: readonly SlashCommand[], typed: string): readonly SlashCommand[] {
  const word = typed.replace(/^\//, "").toLowerCase();
  const exact = commands.filter((each) => each.name.toLowerCase() === word);
  const starts = commands.filter(
    (each) => each.name.toLowerCase() !== word && each.name.toLowerCase().startsWith(word),
  );
  const within = commands.filter(
    (each) => !each.name.toLowerCase().startsWith(word) && each.name.toLowerCase().includes(word),
  );
  return [...exact, ...starts, ...within];
}

/** Whether a line in the field is a command still being named: a `/` and a word, nothing after. */
export const namingCommand = (line: string): boolean => /^\/\S*$/.test(line);

/** Whether a change of the field's line asks again for a list whose read failed: a fresh `/`, not each letter after it. */
export const retriesAfterFailure = (failed: boolean, before: string, next: string): boolean =>
  failed && namingCommand(next) && !namingCommand(before);
