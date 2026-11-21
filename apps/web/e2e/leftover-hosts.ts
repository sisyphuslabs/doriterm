// Global teardown: each worker stops its own e2e host (and its cores) when it ends, and the host deletes its saved
// environment as it goes. A saved environment still here means a host outlived its worker: stop it, and fail the run
// naming it, so no core is left running (the web e2e counterpart of the host tests' leftover-core guard). The layout
// host this run started is stopped here too, and any hc process it had to stop fails the run (#251); a stop this run
// could not confirm is reported as infrastructure, never as a failed test (#1412).
import { execFileSync } from "node:child_process";
import { type FSWatcher, existsSync, readFileSync, rmSync, watch } from "node:fs";
import { dirname } from "node:path";
import { sweepRunDir } from "@doriface/host/testing/run-dir";
import type { FullConfig } from "@playwright/test";
import { E2E_LAYOUT_ENV, E2E_LAYOUT_LEFT, E2E_LAYOUT_STOPPED, E2E_RUN_ID, hostEnvOf, hostPortOf } from "./config.ts";
import { readSavedEnv, readSavedEnvIfWhole } from "./saved-env.ts";

const STOP_WITHIN_MS = 30_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopHost(file: string): Promise<string> {
  const { hc, env, pid } = readSavedEnv(file);
  const session = env["HC_SESSION"] ?? "?";
  if (pid !== undefined && alive(pid)) {
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + STOP_WITHIN_MS;
    // oxlint-disable-next-line no-await-in-loop -- waits for the host's own shutdown, which stops its cores
    while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (existsSync(file)) {
    // The host is gone without its shutdown: stop its core directly, as host.ts would have.
    execFileSync(hc, ["connect", "--session", session], {
      env: { ...process.env, ...env },
      input: '{"jsonrpc":"2.0","id":1,"method":"server.stop"}\n',
      timeout: STOP_WITHIN_MS,
    });
    rmSync(file, { force: true });
  }
  return session;
}

/**
 * How long the layout host gets to exit before the run stops waiting for it.
 *
 * How long a host takes to stop is the machine's, not a wall clock's: it stops its core, the machine it added and every
 * process it left, and a fixed 60 s window failed runs on a host at load 252 with every test passing (#1412). The wait
 * below ends on the host's own exit, so this bound only catches a host that is stuck rather than slow, and five minutes
 * is five times the window that failed.
 */
const LAYOUT_STOP_WITHIN_MS = 300_000;

/** What stopping the layout host found: a real leak, which fails the run (#251), and a stop this run could not confirm. */
export interface LayoutStop {
  /** hc processes the layout host left and had to stop, as "pid N: arguments" (never an environment) — #251. */
  readonly left: readonly string[];
  /** Why this run could not confirm the layout host stopped, in the host's own terms: infrastructure, not a test. */
  readonly infra: readonly string[];
  /** A step of the layout host's own teardown that failed, as the host reported it (a machine stop that threw). */
  readonly failed: readonly string[];
}

/** The machine stop the layout host reported as failed in `stoppedFile` (e2e/host.ts), if it did (#2594 review). */
function machineStopFailure(stoppedFile: string): string[] {
  if (!existsSync(stoppedFile)) return [];
  let word: unknown;
  try {
    word = JSON.parse(readFileSync(stoppedFile, "utf8"));
  } catch {
    // A stopped word that is not JSON (an older host, a test fixture) reports nothing beyond the stop itself.
    return [];
  }
  const machineStop: unknown = Reflect.get(Object(word), "machineStop");
  return typeof machineStop === "string" ? [`the layout host's machine stop failed: ${machineStop}`] : [];
}

export interface LayoutStopOptions {
  /** The file the layout host writes as its last step before it exits (e2e/host.ts); a test brings its own. */
  readonly stoppedFile?: string;
  /** How long to wait for that exit: the teardown waits the bound above, a test a shorter one. */
  readonly withinMs?: number;
}

/**
 * Whether the layout host has exited, as the host's exit event rather than as a wall clock: this process is its parent,
 * so its SIGCHLD says so at once, and the host itself writes `stoppedFile` as its last step before it goes (for a host
 * whose exit is not this process's to observe). `withinMs` bounds a host that does neither.
 */
async function exited(pid: number, stoppedFile: string, withinMs: number): Promise<boolean> {
  const gone = (): boolean => existsSync(stoppedFile) || !alive(pid);
  if (gone()) return true;
  return await new Promise<boolean>((resolve) => {
    let watcher: FSWatcher | undefined;
    let bound: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let settled = false;
    const finish = (stopped: boolean): void => {
      if (settled) return;
      settled = true;
      process.off("SIGCHLD", check);
      watcher?.close();
      clearTimeout(bound);
      clearInterval(heartbeat);
      resolve(stopped);
    };
    const check = (): void => {
      if (gone()) finish(true);
    };
    // Subscribed before the first look below, so an exit in between is a signal this process still receives.
    process.on("SIGCHLD", check);
    try {
      watcher = watch(dirname(stoppedFile), check);
    } catch {
      // No watch on this platform or dir: the host's exit signal and the bound below still end the wait.
      watcher = undefined;
    }
    bound = setTimeout(() => finish(!alive(pid)), withinMs);
    // Not the wait's decision, and not a wall clock: a once-a-second liveness sample, so a host that died without
    // either signal (a SIGKILL) costs a second rather than the whole bound. Every ordinary stop ends on the exit above.
    heartbeat = setInterval(check, 1_000);
    check();
  });
}

/**
 * Stops the layout host this run started (a webServer, which Playwright stops only after this teardown) and reports what
 * it left running once it had stopped its cores (#251), or why this run could not confirm it stopped (#1412).
 *
 * A run that did not start it — no saved environment, or one another run's — leaves it alone: stopping a pid from
 * another run's file would be a signal to whatever holds that pid now, and reporting it would fail a run that never
 * touched the host.
 */
export async function stopLayoutHost(
  envFile = E2E_LAYOUT_ENV,
  leftFile = E2E_LAYOUT_LEFT,
  options: LayoutStopOptions = {},
): Promise<LayoutStop> {
  const host = readSavedEnvIfWhole(envFile);
  if (host?.run !== E2E_RUN_ID) return { left: [], infra: [], failed: [] };
  const withinMs = options.withinMs ?? LAYOUT_STOP_WITHIN_MS;
  const stoppedFile = options.stoppedFile ?? E2E_LAYOUT_STOPPED;
  const pid = host.pid;
  if (pid !== undefined && alive(pid)) {
    process.kill(pid, "SIGTERM");
    if (!(await exited(pid, stoppedFile, withinMs))) {
      return {
        left: [],
        infra: [
          `the layout host (pid ${pid}) did not exit within ${withinMs} ms of SIGTERM, so this run could not check ` +
            "what it left behind; this is infrastructure, and test results are reported separately",
        ],
        failed: [],
      };
    }
  }
  const failed = machineStopFailure(stoppedFile);
  if (!existsSync(leftFile)) {
    if (pid === undefined) return { left: [], infra: [], failed };
    return { left: [`pid ${pid}: the layout host stopped without its check`], infra: [], failed };
  }
  const left = JSON.parse(readFileSync(leftFile, "utf8")) as { pid: number; command: string }[];
  rmSync(leftFile, { force: true });
  return { left: left.map((one) => `pid ${one.pid}: ${one.command}`), infra: [], failed };
}

/**
 * Reports what this run could not confirm about the layout host's stop as infrastructure, and returns the failures that
 * end the run. An hc process the host left fails it, as it always has (#251); a stop that never came is printed as its
 * own status instead, so "N passed" never sits beside an exit code a reader takes for a failed test (#1412).
 */
export function layoutStopFailures(report: LayoutStop): string[] {
  for (const line of report.infra) console.error(`E2E_INFRA_TIMEOUT: ${line}`);
  const failures = [...report.failed];
  if (report.left.length > 0)
    failures.push(`hc processes left by the layout host (now stopped):\n  ${report.left.join("\n  ")}`);
  return failures;
}

export default async function leftoverHosts(config: FullConfig, options: LayoutStopOptions = {}): Promise<void> {
  const left: string[] = [];
  for (let slot = 0; slot < config.workers; slot++) {
    const file = hostEnvOf(hostPortOf(slot));
    // oxlint-disable-next-line no-await-in-loop -- one host at a time, each fully stopped before the next
    if (existsSync(file)) left.push(`slot ${slot}: ${await stopHost(file)}`);
  }
  const layout = await stopLayoutHost(E2E_LAYOUT_ENV, E2E_LAYOUT_LEFT, options);
  // Last, once every host has stopped: any hc process still holding a file under the run's dir (a spec's own scratch
  // session, a core launchd started on macOS) outlived what started it (#470).
  const swept = await sweepRunDir();
  const failures: string[] = [];
  if (left.length > 0) failures.push(`e2e hosts outlived their workers (now stopped): ${left.join(", ")}`);
  failures.push(...layoutStopFailures(layout));
  if (swept.length > 0) failures.push(`hc processes outlived the web e2e run (now stopped):\n  ${swept.join("\n  ")}`);
  if (failures.length > 0) throw new Error(failures.join("\n"));
}
