/**
 * Brings back one record after the core lost its terminal. A record runs once: it leaves the store before anything
 * starts, so a resume that fails (or crashes the host) is never tried again, and the program must report again to be
 * resumed again. The command goes in a one-use owner-only file that `resume-exec` reads; the only text a shell parses is
 * a fixed line naming this host's program and that file.
 */
import { statSync } from "node:fs";
import { basename } from "node:path";
import type { HcConnection } from "@doriface/client";
import { HcRpcError, type Terminal } from "@doriface/protocol";
import type { ResumeRecord, ResumeStore, TerminalEntry } from "./records.ts";
import { launchPathIn, RESUME_EXEC, shownCommand, writeLaunch } from "./resume-exec.ts";
import { hasControl } from "./osc7577.ts";
import { mintToken, type RunStarted, TOKEN_VAR } from "./run-tokens.ts";

export interface RelaunchDeps {
  readonly connection: Pick<HcConnection, "call">;
  readonly store: ResumeStore;
  /** Where launch files go (owner-only). */
  readonly launchDir: string;
  /** This host's own program, which runs `resume-exec`. */
  readonly program: string;
  /** The user's shell (`$SHELL`), for a record that was its terminal's first process. */
  readonly shell: string | undefined;
  readonly uid: number;
  /** Starts tracking a terminal and settles once its output is watched, so its first report cannot be missed. */
  readonly watch: (run: RunStarted) => Promise<void>;
  readonly log: (line: string) => void;
  readonly mint?: () => string;
}

const POSIX_SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "yash", "loksh"]);

/** How a shell runs `exec` of its arguments from fixed source text, or undefined for a shell this does not know. */
function execScript(shell: string | undefined): string | undefined {
  const name = shell === undefined ? "" : basename(shell).replace(/^-/, "");
  if (POSIX_SHELLS.has(name)) return 'exec "$0" "$@"';
  return name === "fish" ? "exec $argv" : undefined;
}

/** `text` in single quotes, which every known shell reads literally; undefined when it holds a quote or backslash. */
const quoted = (text: string): string | undefined =>
  text.includes("'") || text.includes("\\") || hasControl(text) ? undefined : `'${text}'`;

const isDirectory = (path: string | undefined): boolean =>
  path !== undefined && statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

/** Runs `params` under `name` when it is free, else unnamed (another terminal took the name meanwhile). */
async function runNamed(deps: RelaunchDeps, name: string | null, params: object): Promise<Terminal> {
  if (name !== null) {
    try {
      return await deps.connection.call("terminal.run", { ...params, name });
    } catch (error) {
      if (!(error instanceof HcRpcError)) throw error;
    }
  }
  return deps.connection.call("terminal.run", params);
}

/** Relaunches the record of `address` (gone from the core, or `old`: finished by the core's stop). */
export async function relaunch(deps: RelaunchDeps, address: string, old: Terminal | undefined): Promise<void> {
  const entry = deps.store.take(address);
  const record = entry?.record;
  if (entry === undefined || record === undefined) return;
  const shown = shownCommand(record.argv);
  const refuse = (why: string): void => deps.log(`resume: not resuming ${shown} (${address}): ${why}`);
  if (record.uid !== deps.uid) return refuse("it was accepted for another user");
  if (record.cwdReported && !isDirectory(record.cwd)) return refuse("its directory is gone");
  const file = launchPathIn(deps.launchDir);
  const token = (deps.mint ?? mintToken)();
  const started = await start(deps, entry, record, file, token);
  const { terminal } = started;
  await deps.watch({ address: terminal.address, token, name: terminal.name ?? null, env: entry.env });
  // Only now does the command exist for `resume-exec` to read: the new terminal is watched before it can report.
  writeLaunch(file, { argv: record.argv, cwd: record.cwd, cwdReported: record.cwdReported, uid: deps.uid });
  await started.typeLine();
  deps.log(`resume: resumed ${shown} in ${terminal.address} (was ${address})`);
  if (old?.state === "finished") {
    await deps.connection.call("terminal.rm", { terminal: address }).catch((error: unknown) => {
      if (!(error instanceof HcRpcError && error.kind === "not_found"))
        deps.log(`resume: removing ${address}: ${String(error)}`);
    });
  }
}

interface Started {
  readonly terminal: Terminal;
  /** Types the fixed line into the shell; nothing for a first process, which runs `resume-exec` itself. */
  readonly typeLine: () => Promise<unknown>;
}

/**
 * Starts the terminal: the record's own program as the first process again when it was, else the user's interactive
 * shell, after its startup files, which gets the fixed line at its first prompt so the program runs as its foreground
 * job. Either way `resume-exec` waits for the launch file, written once the terminal is watched.
 */
async function start(
  deps: RelaunchDeps,
  entry: TerminalEntry,
  record: ResumeRecord,
  file: string,
  token: string,
): Promise<Started> {
  const env = { ...entry.env, [TOKEN_VAR]: token };
  const cwd = isDirectory(record.cwd) ? { cwd: record.cwd } : {};
  const helper = [deps.program, RESUME_EXEC, file];
  if (!record.firstProcess) {
    const shell = await runNamed(deps, entry.name, { env, ...cwd });
    const words = helper.map(quoted);
    if (execScript(shell.argv[0]) !== undefined && words.every((word) => word !== undefined)) {
      // A leading space keeps the line out of a shell history that ignores such lines.
      const text = ` ${words.join(" ")}`;
      return {
        terminal: shell,
        typeLine: () => deps.connection.call("terminal.send", { terminal: shell.address, text }),
      };
    }
    await deps.connection.call("terminal.kill", { terminal: shell.address });
    await deps.connection.call("terminal.rm", { terminal: shell.address }).catch(() => undefined);
  }
  // Interactive, as the core starts the shell of every new terminal: the same startup files run first.
  const script = execScript(deps.shell);
  const argv = deps.shell === undefined || script === undefined ? helper : [deps.shell, "-i", "-c", script, ...helper];
  return { terminal: await runNamed(deps, entry.name, { argv, env, ...cwd }), typeLine: () => Promise.resolve() };
}
