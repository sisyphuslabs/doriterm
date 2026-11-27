import { mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where e2e runs claim their ports: one directory for every checkout of this user on the computer, not the run's own
 * $TMPDIR, so a run in another checkout sees the claims too (#2943).
 */
export const CLAIMS_DIR = join(homedir(), ".cache", "doriface-e2e", "port-claims");

/** Who holds a claim: the run, and the process whose life the claim lasts (the Playwright runner). */
export interface ClaimOwner {
  readonly run: string;
  readonly pid: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but is another user's.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function ownerOf(file: string): ClaimOwner | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const run = Reflect.get(parsed, "run");
    const pid = Reflect.get(parsed, "pid");
    return typeof run === "string" && typeof pid === "number" ? { run, pid } : undefined;
  } catch {
    return undefined;
  }
}

/** Claims one port: true when this owner now holds it. A claim whose owner is gone is taken over. */
function claimPort(dir: string, port: number, owner: ClaimOwner): boolean {
  const file = join(dir, `port-${port}`);
  for (const takeOver of [false, true]) {
    try {
      // "wx" creates the file only if it does not exist: of two runs claiming the same port, exactly one succeeds.
      const fd = openSync(file, "wx");
      writeSync(fd, JSON.stringify(owner));
      closeSync(fd);
      return true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const held = ownerOf(file);
      // A claim still being written reads as no owner: it is live, never taken over.
      if (takeOver || held === undefined || alive(held.pid)) return false;
      rmSync(file, { force: true });
    }
  }
  return false;
}

/**
 * Claims `count` consecutive ports from `base` for `owner`, all or none: a run's ports are its own for as long as its
 * runner lives, so a second run picking at the same moment cannot be handed any of them (#2943). Freeing a port to
 * check it, as the picker does, reserves nothing.
 */
export function claimBlock(base: number, count: number, owner: ClaimOwner, dir = CLAIMS_DIR): boolean {
  mkdirSync(dir, { recursive: true });
  const claimed: number[] = [];
  for (let port = base; port < base + count; port++) {
    if (!claimPort(dir, port, owner)) {
      for (const done of claimed) rmSync(join(dir, `port-${done}`), { force: true });
      return false;
    }
    claimed.push(port);
  }
  return true;
}

/** Gives back every port `run` claimed: the run's teardown calls it. */
export function releaseRun(run: string, dir = CLAIMS_DIR): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = join(dir, name);
    if (name.startsWith("port-") && ownerOf(file)?.run === run) rmSync(file, { force: true });
  }
}
