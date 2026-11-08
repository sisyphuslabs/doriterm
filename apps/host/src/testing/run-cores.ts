import { readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/** Set in the environment of a test run; every process the run starts inherits it, unless something strips it. */
export const RUN_MARK = "DORIFACE_TEST_RUN";

/**
 * A test run: its mark, and the dir that is its $TMPDIR, under which every scratch session of the run keeps its socket
 * and state. On macOS hc starts a core through a one-shot launchd job (unless over ssh), whose environment is launchd's
 * own, without the mark; such a core is the run's because it holds files under `dir` (#232).
 */
export interface TestRun {
  readonly mark: string;
  /** Resolved (no symlink in it): the paths a process is seen holding are. */
  readonly dir: string;
}

/** Set by `bun run test`'s runner to the run's dir, where the suite records what it leaves (see recordLeft). */
export const RUN_DIR = "DORIFACE_TEST_RUN_DIR";

const LEFT_FILE = "suite-left.json";

/**
 * A process of a run: one that carries its mark, whatever its program; a herdr process holding a file in its dir; or
 * one the suite recorded as left when it ended (and its descendants), since macOS hides the environment of Apple
 * platform binaries (`/bin/sh`, `/bin/sleep`) from `ps -E`, so a shell a test left shows no mark there.
 */
export interface RunProcess {
  readonly pid: number;
  readonly command: string;
  /** An owned session leader can be stopped as a group, including children forked between scans. */
  readonly group?: number;
  /** Captured by the process-table scan; prevents retaining ownership across PID reuse. */
  readonly started?: string;
  /** Whether it is a herdr process (`herdr-core` or its `hc` alias). */
  readonly herdr: boolean;
  /**
   * Which test started it: the session, socket and runtime dir from its environment, or for a core without the mark
   * the file in the run's dir it holds.
   */
  readonly where: string;
}

const WHERE_KEYS = ["HC_SESSION", "HC_SOCKET", "XDG_RUNTIME_DIR"];

const whereOf = (vars: readonly string[]): string =>
  WHERE_KEYS.map((key) => vars.find((entry) => entry.startsWith(`${key}=`)) ?? `${key} unset`).join(" ");

const isHerdr = (argv0: string): boolean => ["herdr-core", "hc"].includes(basename(argv0));

const hasCode = (error: unknown, ...codes: readonly string[]): boolean =>
  error instanceof Error && "code" in error && typeof error.code === "string" && codes.includes(error.code);

/** Signal an owned pid (or an explicitly owned negative process-group id); an exited process needs no signal. */
export function signalProcess(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!hasCode(error, "ESRCH")) throw error;
  }
}

/** The first of `paths` under `dir`. */
const under = (dir: string, paths: Iterable<string>): string | undefined => {
  for (const path of paths) if (path.startsWith(`${dir}/`)) return path;
  return undefined;
};

/** The files a process holds open, by path; none for one gone or not this user's. */
function linuxHeld(pid: number): string[] {
  let fds: string[];
  try {
    fds = readdirSync(`/proc/${pid}/fd`);
  } catch (error) {
    if (hasCode(error, "ENOENT", "ESRCH", "EACCES", "EPERM")) return [];
    throw error;
  }
  return fds.flatMap((fd) => {
    try {
      return [readlinkSync(`/proc/${pid}/fd/${fd}`)];
    } catch (error) {
      if (hasCode(error, "ENOENT", "ESRCH", "EACCES", "EPERM")) return [];
      throw error;
    }
  });
}

function linuxRun(run: TestRun): RunProcess[] {
  const mark = `${RUN_MARK}=${run.mark}`;
  const found: RunProcess[] = [];
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid)) continue;
    let environ: string;
    let argv: string[];
    try {
      environ = readFileSync(`/proc/${pid}/environ`, "utf8");
      argv = readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .split("\0")
        .filter((part) => part !== "");
    } catch (error) {
      // gone since readdir, or another user's process
      if (hasCode(error, "ENOENT", "ESRCH", "EACCES", "EPERM")) continue;
      throw error;
    }
    const vars = environ.split("\0");
    const herdr = isHerdr(argv[0] ?? "");
    if (vars.includes(mark)) {
      found.push({ pid, command: argv.join(" "), herdr, where: whereOf(vars) });
      continue;
    }
    const held = herdr ? under(run.dir, linuxHeld(pid)) : undefined;
    if (held !== undefined) found.push({ pid, command: argv.join(" "), herdr, where: `holds ${held}` });
  }
  return found;
}

/** The files each of `pids` holds open, by path (sockets included), from `lsof`. */
async function macHeld(pids: readonly number[]): Promise<Map<number, string[]>> {
  const held = new Map<number, string[]>();
  if (pids.length === 0) return held;
  const lsof = Bun.spawn(["lsof", "-nP", "-Fn", "-p", pids.join(",")], { stdout: "pipe", stderr: "ignore" });
  const [text, code] = await Promise.all([new Response(lsof.stdout).text(), lsof.exited]);
  // 1 when some pid has exited since ps listed it; the others are still listed.
  if (code !== 0 && code !== 1) throw new Error(`lsof exited ${code}`);
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n")) held.set(pid, [...(held.get(pid) ?? []), line.slice(1)]);
  }
  return held;
}

async function macRun(run: TestRun): Promise<RunProcess[]> {
  const mark = `${RUN_MARK}=${run.mark}`;
  // `ps -E` appends each process's environment to its command; it shows it for this user's processes.
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("no uid to scan processes for");
  const ps = Bun.spawn(["ps", "-Eww", "-U", String(uid), "-o", "pid=,command="], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const [text, code] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
  if (code !== 0) throw new Error(`ps exited ${code}`);
  const found: RunProcess[] = [];
  const unmarked: { pid: number; command: string }[] = [];
  for (const line of text.split("\n")) {
    const [pid, argv0, ...rest] = line.trim().split(/\s+/);
    if (pid === undefined || argv0 === undefined) continue;
    const command = [argv0, ...rest.filter((word) => !word.includes("="))].join(" ");
    if (rest.includes(mark)) found.push({ pid: Number(pid), command, herdr: isHerdr(argv0), where: whereOf(rest) });
    else if (isHerdr(argv0)) unmarked.push({ pid: Number(pid), command });
  }
  const held = await macHeld(unmarked.map(({ pid }) => pid));
  for (const { pid, command } of unmarked) {
    const path = under(run.dir, held.get(pid) ?? []);
    if (path !== undefined) found.push({ pid, command, herdr: true, where: `holds ${path}` });
  }
  return found;
}

interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** When it started, as `ps` prints it: with its pid, it names one process even if the pid is reused later. */
  readonly started: string;
  readonly command: string;
}

/** Every process of the machine with its parent and start time, from `ps` (the same columns on Linux and macOS). */
async function processTable(): Promise<{ rows: ProcessRow[]; self: number }> {
  const ps = Bun.spawn(["ps", "-A", "-o", "pid=,ppid=,pgid=,stat=,lstart=,command="], {
    env: { ...process.env, LC_ALL: "C" },
    stdout: "pipe",
    stderr: "inherit",
  });
  const [text, code] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
  if (code !== 0) throw new Error(`ps exited ${code}`);
  const rows = text.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/.exec(line);
    if (match === null) return [];
    const [, pid, ppid, pgid, state, started, command] = match;
    // Zombies have already exited and cannot fork or hold resources; only their parent can reap their status.
    if (state?.startsWith("Z")) return [];
    return [
      {
        pid: Number(pid),
        ppid: Number(ppid),
        pgid: Number(pgid),
        started: (started ?? "").replace(/\s+/g, " "),
        command: command ?? "",
      },
    ];
  });
  return { rows, self: ps.pid };
}

/** The live processes below `roots` in `rows`, the roots excluded. */
function descendants(roots: ReadonlySet<number>, rows: readonly ProcessRow[]): ProcessRow[] {
  const found: ProcessRow[] = [];
  const seen = new Set(roots);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (seen.has(row.pid) || !seen.has(row.ppid)) continue;
      seen.add(row.pid);
      found.push(row);
      grew = true;
    }
  }
  return found;
}

/**
 * Records in `dir` every live process below `root` (by default this process), each by pid and start time. The preloaded
 * guard calls it as the suite ends, while a process a test left is still below the suite, whatever its environment.
 */
export async function recordLeft(dir: string, root = process.pid): Promise<void> {
  const { rows, self } = await processTable();
  const left = descendants(new Set([root]), rows).filter((row) => row.pid !== self);
  writeFileSync(join(dir, LEFT_FILE), JSON.stringify(left.map(({ pid, started }) => ({ pid, started }))));
}

/** The processes the suite recorded as left that are still the same processes, and their live descendants. */
async function leftProcesses(run: TestRun): Promise<RunProcess[]> {
  let recorded: { pid: number; started: string }[];
  try {
    recorded = JSON.parse(readFileSync(join(run.dir, LEFT_FILE), "utf8")) as typeof recorded;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
  const { rows } = await processTable();
  const same = rows.filter((row) => recorded.some((entry) => entry.pid === row.pid && entry.started === row.started));
  return [...same, ...descendants(new Set(same.map((row) => row.pid)), rows)].map((row) => ({
    pid: row.pid,
    started: row.started,
    command: row.command,
    herdr: isHerdr(row.command.split(" ")[0] ?? ""),
    where: "left by the suite when it ended",
  }));
}

/** The processes of `run`, including previously discovered descendants while their PID/start identity still matches. */
export async function runProcesses(run: TestRun, previous: readonly RunProcess[] = []): Promise<RunProcess[]> {
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw new Error(`no process scan on ${process.platform}`);
  const before = new Map((await processTable()).rows.map((row) => [row.pid, row.started]));
  const found = process.platform === "linux" ? linuxRun(run) : await macRun(run);
  const discovered = [
    ...found.map((one) => ({
      pid: one.pid,
      command: one.command,
      herdr: one.herdr,
      where: one.where,
      started: before.get(one.pid),
    })),
    ...(await leftProcesses(run)),
    ...previous,
  ];
  // A child may scrub its environment. Capture descendants while their marked parent is still alive.
  const { rows, self } = await processTable();
  const owned = new Map<number, RunProcess>();
  for (const row of rows) {
    const known = discovered.find((one) => one.pid === row.pid && one.started === row.started);
    if (known !== undefined) owned.set(row.pid, { ...known, started: row.started });
  }
  for (const row of descendants(new Set(owned.keys()), rows)) {
    if (!owned.has(row.pid))
      owned.set(row.pid, { ...row, herdr: isHerdr(row.command.split(" ")[0] ?? ""), where: "child of a run process" });
  }
  return rows.flatMap((row) => {
    const one = owned.get(row.pid);
    if (one === undefined || row.pid === process.pid || row.pid === self) return [];
    return [
      {
        pid: one.pid,
        command: one.command,
        herdr: one.herdr,
        where: one.where,
        started: row.started,
        ...(row.pgid === row.pid ? { group: row.pgid } : {}),
      },
    ];
  });
}

/** The herdr processes of `run`. */
export async function runCores(run: TestRun): Promise<RunProcess[]> {
  return (await runProcesses(run)).filter((found) => found.herdr);
}

const ROUND_MS = 100;
/** Rounds that only wait for the run's processes to exit by themselves, before any is stopped. */
const GRACE_ROUNDS = 20;
const ROUNDS = 120;
/**
 * Empty scans in a row that end the stops. One scan can miss a process handing off to its child (`hc connect` exiting as
 * the core it started comes up): the parent is gone before its environment is read, the child is not yet listed.
 */
const EMPTY_SCANS = 3;

/**
 * Stops every process of `run` (see runProcesses) by its owned group or pid, and returns them: a shell a test left can start a core
 * after any scan for cores alone, and `hc server stop` does not stop a core launchd started. It first gives them GRACE_ROUNDS to exit by themselves, then stops what is left and
 * scans again until EMPTY_SCANS scans in a row find none, so a core started meanwhile (by such a shell, or a dialer's reconnect) is
 * stopped and returned too. A pid that is not a child of this process has no exit event, so each round waits ROUND_MS
 * before it scans again.
 */
export async function stopRunProcesses(run: TestRun): Promise<RunProcess[]> {
  const seen = new Map<number, RunProcess>();
  const known = new Map<number, RunProcess>();
  const round = async (n: number, empty: number): Promise<RunProcess[]> => {
    const found = await runProcesses(run, [...known.values()]);
    for (const child of found) known.set(child.pid, child);
    if (found.length === 0) {
      if (empty + 1 === EMPTY_SCANS) return [...seen.values()];
      await Bun.sleep(ROUND_MS);
      return round(n + 1, empty + 1);
    }
    if (n >= ROUNDS) {
      throw new Error(`processes of run ${run.mark} still running after ${(ROUNDS * ROUND_MS) / 1000} s of stops`);
    }
    for (const core of n < GRACE_ROUNDS ? [] : found) {
      seen.set(core.pid, core);
      // A group gets one terminal signal: stopping just its supervisor first lets a child keep respawning.
      const signal = core.group !== undefined || n >= (GRACE_ROUNDS + ROUNDS) / 2 ? "SIGKILL" : "SIGTERM";
      signalProcess(core.group === undefined ? core.pid : -core.group, signal);
    }
    await Bun.sleep(ROUND_MS);
    return round(n + 1, 0);
  };
  return round(0, 0);
}
