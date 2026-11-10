import type { HcConnection } from "@doriface/client";
import {
  GIT_FACTS_DOC,
  type GitFacts,
  type GitFactsDoc,
  HcRpcError,
  type JsonValue,
  parseGitFacts,
  type Terminal,
} from "@doriface/protocol";
import { type HcTarget, type KillableLink, openOnCore, spawnHcLink } from "./mesh/hc-machines.ts";

const TICK_MS = 5_000;
const GIT_TIMEOUT_MS = 5_000;
/** At most this many directories are read per tick, and this many at once. */
const MAX_DIRS = 64;
const PARALLEL = 4;

/** Runs `git` in a directory and returns what it printed, or undefined when it failed (not a repository, too slow). */
export type RunGit = (dir: string, args: readonly string[]) => Promise<string | undefined>;

/**
 * Reads only: no optional locks (status would otherwise refresh the index and take its lock under the user's feet),
 * and no fsmonitor, which a repository's own config can point at a program of its choosing.
 */
export const runGit: RunGit = async (dir, args) => {
  const child = Bun.spawn(["git", "-C", dir, "--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
  try {
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return code === 0 ? out : undefined;
  } finally {
    clearTimeout(timer);
  }
};

/** What `git status --porcelain=v2 --branch` says about the branch and the work tree. */
export function parseStatus(text: string): Omit<GitFacts, "onDefault"> {
  let head: string | undefined;
  let ahead = 0;
  let behind = 0;
  let dirty = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("# branch.head ")) head = line.slice("# branch.head ".length);
    else if (line.startsWith("# branch.ab ")) {
      const counts = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
      if (counts !== null) {
        ahead = Number(counts[1]);
        behind = Number(counts[2]);
      }
    } else if (line !== "" && !line.startsWith("#")) dirty = true;
  }
  const detached = head === "(detached)";
  const facts = { detached, ahead, behind, dirty };
  return detached || head === undefined ? facts : { branch: head, ...facts };
}

/** A directory's git facts, or undefined when it is not in a repository. */
export async function readGitFacts(dir: string, run: RunGit = runGit): Promise<GitFacts | undefined> {
  const status = await run(dir, ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"]);
  if (status === undefined) return undefined;
  const facts = parseStatus(status);
  const origin = (await run(dir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]))?.trim();
  const defaultBranch = origin === undefined || origin === "" ? undefined : origin.replace(/^origin\//, "");
  const onDefault =
    facts.branch !== undefined &&
    (defaultBranch === undefined
      ? facts.branch === "main" || facts.branch === "master"
      : facts.branch === defaultBranch);
  return { ...facts, onDefault };
}

/** The directories this core's own live terminals sit in: each one's foreground cwd, else its cwd. */
export function dirsOf(terminals: readonly Terminal[]): string[] {
  const dirs = new Set<string>();
  for (const terminal of terminals) {
    if (terminal.state !== "live" || terminal.address.includes("/")) continue;
    dirs.add(terminal.foreground?.cwd ?? terminal.cwd);
  }
  return [...dirs].slice(0, MAX_DIRS);
}

/** The facts of every directory that is in a repository. */
export async function collectGitFacts(dirs: readonly string[], run: RunGit = runGit): Promise<GitFactsDoc> {
  const found: Record<string, GitFacts> = {};
  const queue = [...dirs];
  const worker = async (): Promise<void> => {
    for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
      // oxlint-disable-next-line no-await-in-loop -- each worker reads its directories one after another
      const facts = await readGitFacts(dir, run);
      if (facts !== undefined) found[dir] = facts;
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  const dirsInOrder = Object.fromEntries(dirs.filter((dir) => dir in found).map((dir) => [dir, found[dir]]));
  return { v: 1, dirs: dirsInOrder as Record<string, GitFacts> };
}

const isConflict = (error: unknown): boolean => error instanceof HcRpcError && error.kind === "conflict";

const same = (a: GitFactsDoc | undefined, b: GitFactsDoc): boolean => JSON.stringify(a) === JSON.stringify(b);

const toJson = (doc: GitFactsDoc): JsonValue => ({
  v: 1,
  dirs: Object.fromEntries(Object.entries(doc.dirs).map(([dir, facts]) => [dir, { ...facts }])),
});

async function writeOnce(connection: Pick<HcConnection, "call">, doc: GitFactsDoc): Promise<"written" | "unchanged"> {
  const current = await connection.call("doc.get", { name: GIT_FACTS_DOC });
  if (same(parseGitFacts(current.value), doc)) return "unchanged";
  await connection.call("doc.set", { name: GIT_FACTS_DOC, value: toJson(doc), version: current.version });
  return "written";
}

/** Writes `doc` unless the core holds it already; a `conflict` (another writer moved the document) is read and written once more. */
export function writeGitFacts(
  connection: Pick<HcConnection, "call">,
  doc: GitFactsDoc,
): Promise<"written" | "unchanged"> {
  return writeOnce(connection, doc).catch((error: unknown) =>
    isConflict(error) ? writeOnce(connection, doc) : Promise.reject(error),
  );
}

export interface GitFactsPublisher {
  /** Ends the ticks; settles once the current tick's `hc connect` child has exited. */
  stop(): Promise<void>;
  /** Kills the current tick's child if it has not exited, and returns the pids it killed. */
  kill(): readonly number[];
  /**
   * Settles once the tick in flight (if any) is over and its `hc connect` child has exited. The next tick waits on a
   * timer, so no child of the publisher's runs between this settling and the caller's next step.
   */
  settled(): Promise<void>;
}

/**
 * Keeps the git facts of this host's terminals on its own core, every few seconds over a `hc connect` child of each
 * tick's own. A client reads them for this machine, or `on` a machine whose own host writes them there.
 */
export function publishGitFacts(
  core: HcTarget,
  log: (line: string) => void,
  link: (core: HcTarget) => KillableLink = spawnHcLink,
  run: RunGit = runGit,
): GitFactsPublisher {
  let stopped = false;
  let child: KillableLink | undefined;
  let childOpen = false;
  let exited: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastError: string | undefined;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      // Inside the try: a spawn that fails (hc gone, its directory removed) is logged like any other failed tick.
      const current = link(core);
      child = current;
      childOpen = true;
      exited = new Promise<void>((resolve) =>
        current.onClose(() => {
          childOpen = false;
          resolve();
        }),
      );
      try {
        const connection = await openOnCore(current, core);
        try {
          const listed = await connection.call("terminal.list", {});
          await writeGitFacts(connection, await collectGitFacts(dirsOf(listed.terminals), run));
          lastError = undefined;
        } finally {
          connection.close();
        }
      } finally {
        current.close();
        await exited;
      }
    } catch (error) {
      const line = `host: cannot write the git facts on its core: ${String(error)}`;
      if (!stopped && line !== lastError) log(line);
      lastError = line;
    }
    if (!stopped) timer = setTimeout(start, TICK_MS);
  };
  let running: Promise<void> = Promise.resolve();
  function start(): void {
    running = tick();
  }
  start();
  return {
    settled: () => running,
    stop() {
      stopped = true;
      clearTimeout(timer);
      child?.close();
      return exited;
    },
    kill() {
      if (child?.kill === undefined || child.pid === undefined || !childOpen) return [];
      child.kill("SIGKILL");
      return [child.pid];
    },
  };
}
