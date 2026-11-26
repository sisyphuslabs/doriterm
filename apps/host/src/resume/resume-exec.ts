/**
 * `doriface-host resume-exec <file>`: starts one resumed command. The host types this line, and nothing else, into the
 * user's own shell at its prompt, so the command runs after the shell's startup files, in its environment, as its
 * foreground job. The command itself travels in a one-use owner-only file, never as shell text: each element reaches
 * the program as one argument, and a shell function, alias or builtin of the same name cannot run in its place.
 */
import { existsSync, lstatSync, readFileSync, statSync, unlinkSync, watch } from "node:fs";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { ensureStateDir, writePrivateJson } from "../state/files.ts";
import { hasControl } from "./osc7577.ts";

export const RESUME_EXEC = "resume-exec";
export const RESUME_EXEC_USAGE =
  "usage: doriface-host resume-exec <launch file>   (typed by the host; runs one resume)";

/** The `resume-exec` command line: one launch file. */
export function resumeExecCommand(args: readonly string[]): Promise<number> {
  const [path, ...rest] = args;
  if (path === undefined || rest.length > 0) {
    process.stderr.write(`${RESUME_EXEC_USAGE}\n`);
    return Promise.resolve(2);
  }
  return resumeExec(path);
}

export interface Launch {
  readonly argv: readonly string[];
  readonly cwd: string | undefined;
  readonly cwdReported: boolean;
  readonly uid: number;
}

/** How long `resume-exec` waits for its launch file, which the host writes once it watches the new terminal. */
export const LAUNCH_WAIT_MS = 30_000;

/** A new launch file's path in `dir` (made owner-only); the file is written later, by `writeLaunch`. */
export function launchPathIn(dir: string): string {
  ensureStateDir(dir);
  return join(dir, `${crypto.randomUUID()}.json`);
}

/** Writes `launch` whole (a rename), so a waiting `resume-exec` never reads half of it. */
export function writeLaunch(path: string, launch: Launch): void {
  writePrivateJson(path, launch);
}

/** Settles once `path` exists, or after `ms`, whichever is first. */
async function appeared(path: string, ms: number): Promise<void> {
  if (existsSync(path)) return;
  const done = Promise.withResolvers<void>();
  const watcher = watch(dirname(path), () => {
    if (existsSync(path)) done.resolve();
  });
  const timer = setTimeout(done.resolve, ms);
  if (existsSync(path)) done.resolve();
  await done.promise;
  clearTimeout(timer);
  watcher.close();
}

const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** A command as a person may read it in a log: quoted where needed, controls and direction overrides escaped. */
export function shownCommand(argv: readonly string[]): string {
  return argv
    .map((element) => {
      const quoted = /^[A-Za-z0-9_./:=@%+,-]+$/.test(element) ? element : JSON.stringify(element);
      return quoted.replace(BIDI, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
    })
    .join(" ");
}

class Refused extends Error {}

const ignore = (): void => {};

/** The launch in `path`, read once and removed whatever it holds; refused unless it is this user's private file. */
function readLaunch(path: string): Launch {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) throw new Refused("the launch file is gone (a resume runs once)");
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Refused("the launch file is not a private file of this user");
  }
  const text = readFileSync(path, "utf8");
  unlinkSync(path);
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) throw new Refused("the launch file holds no launch");
  const argv: unknown = Reflect.get(value, "argv");
  const cwd: unknown = Reflect.get(value, "cwd");
  const cwdReported: unknown = Reflect.get(value, "cwdReported");
  const uid: unknown = Reflect.get(value, "uid");
  if (!Array.isArray(argv) || !argv.every((item): item is string => typeof item === "string" && !hasControl(item))) {
    throw new Refused("the command is not a list of text arguments");
  }
  const program = argv[0] ?? "";
  if (program === "" || (!program.startsWith("/") && (program.includes("/") || program.startsWith("-")))) {
    throw new Refused("the program is neither a bare command name nor an absolute path");
  }
  if (cwd !== undefined && (typeof cwd !== "string" || !cwd.startsWith("/")))
    throw new Refused("the cwd is not absolute");
  if (uid !== process.getuid?.()) throw new Refused("the command was accepted for another user");
  return { argv, cwd, cwdReported: cwdReported === true, uid };
}

const isDirectory = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

export interface ResumeExecOptions {
  readonly waitMs?: number;
  readonly stdio?: ["inherit" | "ignore", "inherit" | "ignore", "inherit" | "ignore"];
  readonly say?: (line: string) => void;
}

/** Runs the launch in `path` and answers its exit code (128 + n for a signal); a refusal says why and answers 1. */
export async function resumeExec(path: string, options: ResumeExecOptions = {}): Promise<number> {
  const say = options.say ?? ((line: string) => process.stderr.write(`doriterm: ${line}\n`));
  let launch: Launch;
  try {
    await appeared(path, options.waitMs ?? LAUNCH_WAIT_MS);
    launch = readLaunch(path);
  } catch (error) {
    say(`not resuming: ${error instanceof Refused ? error.message : String(error)}`);
    return 1;
  }
  const shown = shownCommand(launch.argv);
  let cwd = launch.cwd !== undefined && isDirectory(launch.cwd) ? launch.cwd : undefined;
  if (launch.cwd !== undefined && cwd === undefined) {
    if (launch.cwdReported) {
      say(`not resuming ${shown}: its directory ${JSON.stringify(launch.cwd)} is gone`);
      return 1;
    }
    cwd = process.cwd();
  }
  const [program = "", ...rest] = launch.argv;
  // A bare name is looked up on this process's PATH: the shell's own, after its startup files.
  const resolved = program.startsWith("/") ? program : Bun.which(program, { PATH: process.env["PATH"] ?? "" });
  if (resolved === null) {
    say(`not resuming ${shown}: ${program} is not on PATH`);
    return 1;
  }
  // The program shares this foreground job: a Ctrl+C or Ctrl+\ is the program's to handle, and this waits for it.
  process.on("SIGINT", ignore);
  process.on("SIGQUIT", ignore);
  try {
    const child = Bun.spawn([resolved, ...rest], {
      argv0: program,
      cwd: cwd ?? process.cwd(),
      env: process.env,
      stdio: options.stdio ?? ["inherit", "inherit", "inherit"],
    });
    const code = await child.exited;
    const signal = child.signalCode;
    if (signal === null) return code;
    return 128 + (typeof signal === "number" ? signal : constants.signals[signal]);
  } finally {
    process.off("SIGINT", ignore);
    process.off("SIGQUIT", ignore);
  }
}
