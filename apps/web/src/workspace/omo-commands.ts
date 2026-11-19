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
const REQUEST = `${JSON.stringify({ id: "doriterm-commands", type: "get_commands" })}\n`;

/** How long a listing may take before it counts as failed; OmO starts its session first, about two seconds. */
const LIST_TIMEOUT_S = 30;

const base = (path: string): string => path.split(/[/\\]/).at(-1) ?? path;

/**
 * The OmO program a terminal runs in front of its shell, as it was started (a path, or `omo` found on the PATH); null
 * when what runs there is not OmO.
 */
export function omoProgram(terminal: Terminal): string | null {
  const front = terminal.foreground;
  if (front === undefined || front === null) return null;
  // OmO as a script runs under its interpreter (`sh /path/omo`, `node /path/omo`): its path is the argument named omo.
  const named = front.argv.find((each) => base(each).replace(/\.exe$/i, "") === "omo");
  if (named !== undefined) return named;
  return base(front.name) === "omo" ? "omo" : null;
}

const utf8 = (base64: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
const toBase64 = (text: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

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
    argv: [where.program, "--mode", "rpc", "--no-session"],
    cwd: where.cwd,
    input: toBase64(REQUEST),
    timeout: LIST_TIMEOUT_S,
    ...(where.machine === undefined ? {} : { on: where.machine }),
  });
  return parseCommands(utf8(result.stdout));
}

/** Listings by machine and program, for this page's life: one OmO start per machine, however many terminals ask. */
export function commandCache(
  list: typeof listCommands = listCommands,
): (exec: ExecOn, where: Parameters<typeof listCommands>[1]) => Promise<readonly SlashCommand[]> {
  const kept = new Map<string, Promise<readonly SlashCommand[]>>();
  return (exec, where) => {
    const key = `${where.machine ?? ""}\n${where.program}`;
    const known = kept.get(key);
    if (known !== undefined) return known;
    const asked = list(exec, where);
    kept.set(key, asked);
    // A failed listing is asked again next time, not remembered.
    asked.catch(() => kept.delete(key));
    return asked;
  };
}

/** The commands a typed `/word` names: those starting with it first, then those containing it, each in OmO's order. */
export function matchCommands(commands: readonly SlashCommand[], typed: string): readonly SlashCommand[] {
  const word = typed.replace(/^\//, "").toLowerCase();
  const starts = commands.filter((each) => each.name.toLowerCase().startsWith(word));
  const within = commands.filter(
    (each) => !each.name.toLowerCase().startsWith(word) && each.name.toLowerCase().includes(word),
  );
  return [...starts, ...within];
}

/** Whether a line in the field is a command still being named: a `/` and a word, nothing after. */
export const namingCommand = (line: string): boolean => /^\/\S*$/.test(line);
