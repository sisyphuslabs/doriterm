/**
 * What the OS says about a process, for OSC 7577's pid checks: who runs it, its parent, when it started (a pid given to
 * a new process reads as another), and its working directory. None of this is security, as the spec says: it catches
 * mistakes, such as a report for a process outside the terminal or one that runs as another user.
 */
import { readFileSync, readlinkSync } from "node:fs";

export interface ProcessFacts {
  readonly uid: number;
  readonly ppid: number;
  /** An opaque start stamp: equal for the same process, different for a reused pid. */
  readonly started: string;
  /** Undefined when the OS does not say. */
  readonly cwd: string | undefined;
}

export type FactsOf = (pid: number) => Promise<ProcessFacts | undefined>;

/** The most parents walked looking for an ancestor; deeper than any terminal's process tree. */
const MAX_DEPTH = 64;

function linuxFacts(pid: number): ProcessFacts | undefined {
  let stat: string;
  let status: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    status = readFileSync(`/proc/${pid}/status`, "utf8");
  } catch {
    return undefined;
  }
  // The command name sits in parentheses and may hold spaces or parentheses itself: fields count from the last ')'.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const state = fields[0];
  const ppid = Number(fields[1]);
  const started = fields[19];
  const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
  if (state === "Z" || started === undefined || !Number.isInteger(ppid) || !Number.isInteger(uid)) return undefined;
  let cwd: string | undefined;
  try {
    cwd = readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    cwd = undefined;
  }
  return { uid, ppid, started, cwd };
}

async function output(argv: readonly string[]): Promise<string> {
  const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [text] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return text;
}

/** macOS (and other BSDs) have no /proc: ps for the user, parent and start, lsof for the working directory. */
async function psFacts(pid: number): Promise<ProcessFacts | undefined> {
  const line = (await output(["ps", "-o", "uid=,ppid=,stat=,lstart=", "-p", String(pid)])).trim();
  const match = /^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
  if (match === null || match[3]?.startsWith("Z") === true) return undefined;
  const cwdLine = (await output(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"]))
    .split("\n")
    .find((each) => each.startsWith("n"));
  return { uid: Number(match[1]), ppid: Number(match[2]), started: match[4] ?? "", cwd: cwdLine?.slice(1) };
}

/** The facts of a live process, or undefined for one that is gone (or a zombie). */
export const processFacts: FactsOf = (pid) =>
  process.platform === "linux" ? Promise.resolve(linuxFacts(pid)) : psFacts(pid);

/** Whether `pid` is `root` or one of its descendants. */
export async function descends(pid: number, root: number, factsOf: FactsOf = processFacts): Promise<boolean> {
  let at = pid;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (at === root) return true;
    if (at <= 1) return false;
    // oxlint-disable-next-line no-await-in-loop -- each step asks for the parent the previous step found
    const facts = await factsOf(at);
    if (facts === undefined) return false;
    at = facts.ppid;
  }
  return false;
}
