import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

/**
 * Where e2e runs claim their ports: one directory for every checkout of this user on the computer, not the run's own
 * $TMPDIR, so a run in another checkout sees the claims too (#2943).
 */
export const CLAIMS_DIR = join(homedir(), ".cache", "doriface-e2e", "port-claims");

/**
 * Who holds a claim: the run, and the process whose life the claim lasts (the Playwright runner), on which computer and
 * since which boot, so a pid reused after a reboot is not taken for the runner, and another computer's is never judged.
 */
export interface ClaimOwner {
  readonly run: string;
  readonly pid: number;
  readonly host: string;
  readonly boot: string;
}

/**
 * This boot of this computer, as the system names it: unlike a boot time worked out from the clock, it does not move when
 * the clock is stepped (NTP, a laptop waking), so a live runner's claims are never judged from an earlier boot. Empty
 * where the system names none: such a claim is judged by its pid alone.
 */
function readBootId(): string {
  try {
    if (process.platform === "linux") return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (process.platform === "darwin")
      return execFileSync("sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
  return "";
}
const BOOT = readBootId();

/** This process as a claim's owner, for `run`. */
export function ownerFor(run: string): ClaimOwner {
  return { run, pid: process.pid, host: hostname(), boot: BOOT };
}

/** What a claim may be refused for: the owner that holds its port, when the claim file names one. */
export type Claimed = { readonly ok: true } | { readonly ok: false; readonly holder: ClaimOwner | undefined };

function readOwner(file: string): ClaimOwner | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const [run, pid, host, boot] = ["run", "pid", "host", "boot"].map((key) => Reflect.get(parsed, key));
    return typeof run === "string" && typeof pid === "number" && typeof host === "string" && typeof boot === "string"
      ? { run, pid, host, boot }
      : undefined;
  } catch {
    return undefined;
  }
}

const sameOwner = (a: ClaimOwner | undefined, b: ClaimOwner): boolean =>
  a !== undefined && a.run === b.run && a.pid === b.pid && a.host === b.host && a.boot === b.boot;

/** Whether `owner`'s runner is gone: on this computer, from an earlier boot or no longer running. Another's is live. */
function gone(owner: ClaimOwner): boolean {
  if (owner.host !== hostname()) return false;
  if (owner.boot !== "" && BOOT !== "" && owner.boot !== BOOT) return true;
  return !running(owner.pid);
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const isCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

/**
 * Creates `file` naming `owner`, only if no file has that name: the owner is written whole to a file of this owner's
 * own, then linked into place, which fails if the name exists. So a claim file is never seen half-written, and of two
 * owners creating one name, exactly one does.
 */
function createNaming(file: string, owner: ClaimOwner): boolean {
  const draft = `${file}.${owner.run}.${owner.pid}.draft`;
  writeFileSync(draft, JSON.stringify(owner));
  try {
    linkSync(draft, file);
    return true;
  } catch (error) {
    if (isCode(error, "EEXIST")) return false;
    throw error;
  } finally {
    rmSync(draft, { force: true });
  }
}

/**
 * Removes `file` if it still names `stale`, a gone owner: only while holding the port's takeover lock, so of runs that
 * all found the same stale claim, one removes it and the rest find it gone or replaced. Nothing else removes a claim
 * but its own run, so the claim read under the lock is the one removed.
 */
export function takeOver(file: string, stale: ClaimOwner, owner: ClaimOwner): void {
  const lock = `${file}.takeover`;
  if (!createNaming(lock, owner)) return;
  takeOverHolding(lock, file, stale, owner);
}

/**
 * The takeover once `owner` has taken `lock`. A reaper may have moved the lock away since, and another run taken it
 * (reapLock): so the claim is removed only while the lock still names `owner`, and the lock is released only if it
 * does, so a displaced holder backs off and never removes the newcomer's lock or acts on a claim it no longer guards.
 */
export function takeOverHolding(lock: string, file: string, stale: ClaimOwner, owner: ClaimOwner): void {
  try {
    if (sameOwner(readOwner(lock), owner) && sameOwner(readOwner(file), stale)) rmSync(file, { force: true });
  } finally {
    releaseIfOwn(lock, owner);
  }
}

/** Removes `file` if it names `owner`: a run gives back only its own claims. */
function releaseIfOwn(file: string, owner: ClaimOwner): void {
  if (sameOwner(readOwner(file), owner)) rmSync(file, { force: true });
}

function claimPort(file: string, owner: ClaimOwner): Claimed {
  for (const tookOver of [false, true]) {
    if (createNaming(file, owner)) return { ok: true };
    const holder = readOwner(file);
    if (tookOver || holder === undefined || !gone(holder)) return { ok: false, holder };
    takeOver(file, holder, owner);
  }
  return { ok: false, holder: readOwner(file) };
}

/**
 * Removes a takeover lock whose holder is gone (killed inside a takeover), so the port can be taken over again. The lock
 * is moved to a name of this run's own first, so of runs reaping it at once only one gets it; if the moved file is not
 * the gone holder's (a live run took the lock meanwhile), it is put back.
 */
function reapLock(lock: string, holder: ClaimOwner, owner: ClaimOwner): void {
  const tomb = `${lock}.${owner.run}.${owner.pid}.reaped`;
  try {
    renameSync(lock, tomb);
  } catch (error) {
    if (isCode(error, "ENOENT")) return;
    throw error;
  }
  if (!sameOwner(readOwner(tomb), holder)) {
    try {
      linkSync(tomb, lock);
    } catch (error) {
      // Another run took the free name meanwhile: the moved holder is displaced, and backs off (takeOverHolding).
      if (!isCode(error, "EEXIST")) throw error;
    }
  }
  rmSync(tomb, { force: true });
}

/**
 * Takes over every claim whose runner is gone (a run killed before its teardown), so none is left for good, and removes
 * what such a run left mid-claim: its drafts (named after it, so only it ever writes one) and a takeover lock it held.
 */
function sweep(dir: string, owner: ClaimOwner): void {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    const holder = readOwner(file);
    if (holder === undefined || !gone(holder)) continue;
    if (/^port-\d+$/u.test(name)) takeOver(file, holder, owner);
    else if (/^port-\d+\.takeover$/u.test(name)) reapLock(file, holder, owner);
    else if (name.endsWith(`.${holder.run}.${holder.pid}.draft`)) rmSync(file, { force: true });
  }
  // A reaper killed between moving a lock and removing its tomb: the tomb is named after the reaper.
  for (const name of readdirSync(dir)) {
    const reaper = /\.(\d+)\.reaped$/u.exec(name)?.[1];
    if (reaper !== undefined && !running(Number(reaper))) rmSync(join(dir, name), { force: true });
  }
}

/**
 * Claims `count` consecutive ports from `base` for `owner`, all or none: a run's ports are its own for as long as its
 * runner lives, so a second run picking at the same moment cannot be handed any of them (#2943). Freeing a port to
 * check it, as the picker does, reserves nothing. Claims a gone runner left are swept first.
 */
export function claimBlock(base: number, count: number, owner: ClaimOwner, dir = CLAIMS_DIR): Claimed {
  mkdirSync(dir, { recursive: true });
  sweep(dir, owner);
  const claimed: string[] = [];
  for (let port = base; port < base + count; port++) {
    const file = join(dir, `port-${port}`);
    const result = claimPort(file, owner);
    if (!result.ok) {
      for (const done of claimed) releaseIfOwn(done, owner);
      return result;
    }
    claimed.push(file);
  }
  return { ok: true };
}

/** Gives back every port `owner` claimed: the run's teardown and its runner's exit call it. */
export function releaseClaims(owner: ClaimOwner, dir = CLAIMS_DIR): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (isCode(error, "ENOENT")) return;
    throw error;
  }
  for (const name of names) if (/^port-\d+$/u.test(name)) releaseIfOwn(join(dir, name), owner);
}
