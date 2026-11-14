// Each Playwright worker runs its own e2e host (host.ts): its own port, hc session, core and added machine, so specs
// that count the core's terminals never see another worker's. The playwright runner is Node, so this uses child_process.
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { E2E_LAYOUT_PORT, E2E_SLOT, E2E_WEB_PORT, hostEnvOf, hostPortOf } from "./config.ts";
import { coresLeftUnder } from "./core-processes.ts";
import { readSavedEnv, readSavedEnvIfWhole } from "./saved-env.ts";
import { beginWorker, endWorker, WHERE } from "./terminal-guard.ts";
import { record } from "./terminal-ledger.ts";

const HOST_SCRIPT = fileURLToPath(new URL("./host.ts", import.meta.url));
/** Setup seeds the core and adds a machine (a second core) before /healthz answers. */
const READY_WITHIN_MS = 120_000;
/** How much of the host's stderr a failed setup quotes: enough for doriface-host's error and its startup-error line. */
const STDERR_TAIL_LINES = 12;

/** Passes the child's stderr through, and keeps its last lines for the error a failed setup throws (#1279). */
function tailOf(child: ChildProcess): () => string {
  let text = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    text = (text + chunk.toString())
      .split("\n")
      .slice(-STDERR_TAIL_LINES - 1)
      .join("\n");
  });
  return () => text.trimEnd();
}

/** The web tsconfig types ChildProcess without its EventEmitter half, so the exit is read from exitCode/signalCode. */
function exitOf(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      if (child.exitCode === null && child.signalCode === null) return;
      clearInterval(tick);
      resolve(child.exitCode);
    }, 100);
  });
}

async function healthy(
  url: string,
  envFile: string,
  child: ChildProcess,
  exited: Promise<number | null>,
  stderr: () => string,
): Promise<void> {
  const deadline = Date.now() + READY_WITHIN_MS;
  while (child.exitCode === null && child.signalCode === null) {
    // oxlint-disable-next-line no-await-in-loop -- readiness: ask again until the host answers, as webServer does
    const ok = await fetch(url, { signal: AbortSignal.timeout(2_000) }).then(
      (r) => r.ok,
      () => false,
    );
    // Another process can answer on this port (a second checkout's host): ready means the host saved here is this child,
    // and that it has finished seeding its core and adding its machine.
    const saved = ok ? readSavedEnvIfWhole(envFile) : undefined;
    if (saved !== undefined && saved.pid === child.pid && saved.ready === true) return;
    if (Date.now() > deadline)
      throw new Error(
        `the e2e host for ${url} was not ready within ${READY_WITHIN_MS} ms (answered by another process: ${ok})`,
      );
    // oxlint-disable-next-line no-await-in-loop -- as above
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 250))]);
  }
  const code = await exited;
  const how = code === null ? `signal ${String(child.signalCode)}` : `exit ${code}`;
  throw new Error(`the e2e host for ${url} exited during setup (${how}); its stderr ended with:\n${stderr()}`);
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Playwright starts a replacement worker in a slot (a new repeat, or other `test.use` options) without waiting for the
 * old one to finish its teardown, so the slot's previous host may still hold the port and the machine dir. The host
 * deletes its saved environment as it exits; until then its pid there is the one to wait out.
 */
async function previousGone(envFile: string): Promise<void> {
  const pid = readSavedEnvIfWhole(envFile)?.pid;
  if (pid === undefined) return;
  const deadline = Date.now() + READY_WITHIN_MS;
  while (alive(pid)) {
    if (Date.now() > deadline)
      throw new Error(`the slot's previous e2e host (pid ${pid}) did not stop within ${READY_WITHIN_MS} ms`);
    // oxlint-disable-next-line no-await-in-loop -- waits on the previous host's exit, not on a fixed delay
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Starts this worker's e2e host and resolves once it answers; the returned stop ends it, core included. */
export async function startWorkerHost(): Promise<() => Promise<void>> {
  // The host reads its port from E2E_HOST_PORT; without a worker slot of its own it takes that port as is.
  const port = hostPortOf(E2E_SLOT);
  if (port === E2E_LAYOUT_PORT || port === E2E_WEB_PORT) {
    throw new Error(
      `worker ${E2E_SLOT}'s host port ${port} is the layout or web port: keep those outside E2E_HOST_PORT..+workers-1`,
    );
  }
  const env: NodeJS.ProcessEnv = { ...process.env, E2E_HOST_PORT: String(port) };
  delete env["TEST_PARALLEL_INDEX"];
  const url = `http://127.0.0.1:${port}/healthz`;
  await previousGone(hostEnvOf(port));
  // A process already answering here (a second checkout's host) would pass the readiness check for this one.
  const taken = await fetch(url, { signal: AbortSignal.timeout(2_000) }).then(
    () => true,
    () => false,
  );
  if (taken)
    throw new Error(`port ${port} already answers before this worker's host starts: set E2E_HOST_PORT to a free range`);
  const child = spawn("bun", [HOST_SCRIPT], { env, stdio: ["ignore", "inherit", "pipe"] });
  const stderr = tailOf(child);
  const exited = exitOf(child);
  await healthy(url, hostEnvOf(port), child, exited, stderr);
  const dir = dirname(readSavedEnv(hostEnvOf(port)).env["XDG_STATE_HOME"] ?? "");
  // Before any hook runs: the first file's beforeAll terminals are then told apart from what the host started with.
  beginWorker();
  return async () => {
    // The worker's last terminal check reads this host's core, so it runs first; a leak it finds fails once the host
    // has stopped. Then no hc process the host started may still run (#226).
    const failures: string[] = [];
    try {
      endWorker();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    child.kill("SIGTERM");
    // Told to stop, the host exits 0; anything else is a teardown step of its own that failed, such as its machine's
    // stop, whose core it already killed (#2594 review).
    const code = await exited;
    if (code !== 0)
      failures.push(`the e2e host (${WHERE}) exited ${code} when told to stop; its stderr ended with:\n${stderr()}`);
    const left = await coresLeftUnder(dir);
    record({ kind: "cores", where: WHERE, left });
    if (left.length > 0) failures.push(`hc processes left by the e2e host (${WHERE}):\n  ${left.join("\n  ")}`);
    if (failures.length > 0) throw new Error(failures.join("\n"));
  };
}
