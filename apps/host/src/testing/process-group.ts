import type { Subprocess } from "bun";
import { rmSync } from "node:fs";
import { rm } from "node:fs/promises";

const TERM_GRACE_MS = 5_000;
const KILL_GRACE_MS = 2_000;
/** The longest `stopProcessGroup` waits before it gives up: the SIGTERM grace, then the SIGKILL grace. */
export const STOP_BOUND_MS = TERM_GRACE_MS + KILL_GRACE_MS;
const POLL_MS = 25;
const INTERRUPTS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

interface Adopted {
  readonly leader: Subprocess;
  /** Scratch the group used, removed once the group is gone. */
  readonly dir: string;
}

/** Groups started and not yet stopped, by pgid. A group of its own gets none of the signals that end this process. */
const liveGroups = new Map<number, Adopted>();
/** Async teardowns (a harness's own processes outside any group, such as daemons) to run first on an interrupt. */
const cleanups = new Set<() => Promise<void>>();
const CLEANUP_MS = 30_000;
let interruptsHooked = false;

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Whether group `pgid` has no live process left. ESRCH: it is empty. EPERM: on macOS a group whose only member is an
 * unreaped zombie answers EPERM instead of ESRCH; nothing alive in a group of our own can refuse our signal.
 */
function groupGone(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    if (isErrno(error, "ESRCH") || isErrno(error, "EPERM")) return true;
    throw error;
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if (!isErrno(error, "ESRCH") && !isErrno(error, "EPERM")) throw error;
  }
}

/** No exit event exists for processes that are not our children, so the group is checked until a deadline. */
async function goneBy(pgid: number, deadline: number): Promise<boolean> {
  if (groupGone(pgid)) return true;
  if (performance.now() >= deadline) return false;
  await Bun.sleep(POLL_MS);
  return goneBy(pgid, deadline);
}

const goneWithin = (pgid: number, ms: number): Promise<boolean> => goneBy(pgid, performance.now() + ms);

/**
 * SIGKILLs every live group and returns what it killed. The caller works from this snapshot: the leader's exit watcher
 * may unregister a group as soon as it dies.
 */
function killLiveGroups(): Adopted[] {
  const groups = [...liveGroups.values()];
  for (const { leader } of groups) signalGroup(leader.pid, "SIGKILL");
  return groups;
}

function removeDirs(groups: readonly Adopted[]): void {
  for (const { dir } of groups) rmSync(dir, { recursive: true, force: true });
}

/**
 * When this process ends on SIGINT, SIGTERM or SIGHUP before `stopProcessGroup` ran, every live group gets SIGKILL, is
 * awaited (bounded) and has its scratch removed; the signal is then raised again, its listener gone, so the process
 * ends the way the signal asks and only after its groups did. A plain script's `exit` event does the same, without the
 * wait. `bun test` emits no `exit` event: there `stopAdoptedGroups`, preloaded as an `afterAll`, ends what tests left.
 */
function hookInterrupts(): void {
  if (interruptsHooked) return;
  interruptsHooked = true;
  process.once("exit", () => removeDirs(killLiveGroups()));
  for (const signal of INTERRUPTS) {
    process.once(signal, async () => {
      const deadline = new Promise<void>((resolve) => setTimeout(resolve, CLEANUP_MS));
      await Promise.race([Promise.allSettled([...cleanups].map((cleanup) => cleanup())), deadline]);
      const groups = killLiveGroups();
      await Promise.all(groups.map(({ leader }) => goneWithin(leader.pid, KILL_GRACE_MS)));
      removeDirs(groups);
      process.kill(process.pid, signal);
    });
  }
}

/**
 * Registers `leader`'s group, spawned with `detached: true`, and the scratch `dir` it uses, to be ended and removed if
 * nothing stops it first.
 */
export function adoptProcessGroup(leader: Subprocess, dir: string): void {
  liveGroups.set(leader.pid, { leader, dir });
  hookInterrupts();
}

/**
 * Runs `cleanup` (bounded) before the live groups are killed when this process ends on SIGINT, SIGTERM or SIGHUP;
 * returns the function that unregisters it, once the owner tore down by itself.
 */
export function onInterrupt(cleanup: () => Promise<void>): () => void {
  cleanups.add(cleanup);
  hookInterrupts();
  return () => void cleanups.delete(cleanup);
}

/** Stops every group still registered and removes its scratch: the end-of-run cleanup for relays a test left running. */
export async function stopAdoptedGroups(): Promise<void> {
  await Promise.all(
    [...liveGroups.values()].map(async ({ leader, dir }) => {
      await stopProcessGroup(leader);
      await rm(dir, { recursive: true, force: true });
    }),
  );
}

/**
 * Ends `leader`, spawned with `detached: true` so that it leads a process group of its own, together with every
 * process it started in that group: SIGTERM, then SIGKILL if the group outlives the grace period. Resolves once the
 * group is empty and `leader` is reaped; rejects if the group outlives SIGKILL too.
 */
export async function stopProcessGroup(leader: Subprocess): Promise<void> {
  const pgid = leader.pid;
  if (!Number.isSafeInteger(pgid) || pgid <= 1) throw new Error(`refusing to signal process group ${pgid}`);
  signalGroup(pgid, "SIGTERM");
  if (!(await goneWithin(pgid, TERM_GRACE_MS))) {
    signalGroup(pgid, "SIGKILL");
    if (!(await goneWithin(pgid, KILL_GRACE_MS))) {
      throw new Error(`process group ${pgid} outlived SIGKILL by ${KILL_GRACE_MS} ms`);
    }
  }
  liveGroups.delete(pgid);
  await leader.exited;
}
