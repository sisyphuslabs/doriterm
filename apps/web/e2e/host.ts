// Starts doriface-host in loopback dev mode on a scratch hc session; stops the core and deletes its state on exit.
// `bun e2e/host.ts layout` starts the layout spec's host instead: long names, titles and paths on another port.
import { recordLeft, stopRunProcesses } from "@doriface/host/testing/run-cores";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  E2E_HOST_ENV,
  E2E_HOST_PORT,
  E2E_LAYOUT_ENV,
  E2E_LAYOUT_LEFT,
  E2E_LAYOUT_PORT,
  E2E_LAYOUT_STOPPED,
  E2E_PUSH_ORIGIN,
  E2E_RUN_ID,
  E2E_TOKEN,
} from "./config.ts";
import { LAYOUT_CORE, LAYOUT_DIR, LAYOUT_MACHINE_SPEC, LAYOUT_TERMINALS } from "./layout-seed.ts";
import { addMachine, runSeeds } from "./machine.ts";
import { watchParentDeath } from "./parent-death.ts";
import { seedMeshDoc } from "./mesh-doc.ts";
import { writeSavedEnv } from "./saved-env.ts";
import { seed } from "./seed.ts";
import { shellEnv } from "./shell-env.ts";

const layout = process.argv[2] === "layout";
const port = layout ? E2E_LAYOUT_PORT : E2E_HOST_PORT;

const hc = process.env["HC_BIN"] || Bun.which("hc");
if (hc === null || hc === undefined || hc === "") throw new Error("set HC_BIN to an hc 0.1.20 binary");
// Resolved, since a process is seen holding resolved paths (macOS: /var and /tmp are links into /private).
const dir = realpathSync(mkdtempSync(join(tmpdir(), "dw-")));
const session = `web-e2e-${layout ? "layout-" : ""}${crypto.randomUUID().slice(0, 8)}`;
const own = {
  HC_SESSION: session,
  XDG_STATE_HOME: join(dir, "state"),
  XDG_RUNTIME_DIR: join(dir, "run"),
  HC_SOCKET: join(dir, "c.sock"),
};
const env = {
  ...process.env,
  ...own,
  // A plain shell and a neutral core name keep captures free of this machine's identity.
  ...shellEnv(dir),
};
const coreDir = join(dir, "state", "herdr-core", session);
mkdirSync(coreDir, { recursive: true });
writeFileSync(
  join(coreDir, "core.json"),
  JSON.stringify({ id: crypto.randomUUID().replace(/-/g, ""), name: layout ? LAYOUT_CORE : "studio" }),
);
// Saved before the host can answer /healthz, so no spec reads a missing file or one a killed run left behind.
// Each host owns its own file: the layout host runs beside the main ones and must not overwrite or delete theirs.
// The pid lets the run's leftover check stop a host that outlived its worker. The main host's file is saved again with
// `ready` once setup has finished: a worker waits for that, so the core it first sees already holds every seed (#226).
const savedEnv = layout ? E2E_LAYOUT_ENV : E2E_HOST_ENV;
if (layout) {
  rmSync(E2E_LAYOUT_LEFT, { force: true });
  rmSync(E2E_LAYOUT_STOPPED, { force: true });
}
const saved = { hc, env: own, pid: process.pid, run: E2E_RUN_ID };
writeSavedEnv(savedEnv, saved);
const host = Bun.spawn(
  [
    "bun",
    join(import.meta.dir, "../../host/src/cli.ts"),
    "--listen",
    `127.0.0.1:${port}`,
    "--hc",
    hc,
    "--session",
    session,
    "--token",
    E2E_TOKEN,
    "--no-relay",
    // The notifications specs run their own push service here (the layout host too: a connection moves there); nothing
    // listens on it otherwise.
    "--push-test-origin",
    E2E_PUSH_ORIGIN,
  ],
  { env, stdout: "inherit", stderr: "inherit" },
);

async function stopCore(): Promise<void> {
  const control = Bun.spawn([hc ?? "hc", "connect", "--session", session], { env, stdin: "pipe", stdout: "pipe" });
  control.stdin.write('{"jsonrpc":"2.0","id":1,"method":"server.stop"}\n');
  await control.stdin.flush();
  void control.stdin.end();
  await control.exited;
}

/**
 * The layout host is a Playwright webServer, which Playwright stops after the run's teardown, so no hook sees it stop.
 * Once it has stopped its cores, it stops whatever it left with the host tests' guard (#232): processes still running
 * below it, and any hc process holding a file under its dir. It saves them, by pid and arguments only, for the
 * teardown (leftover-hosts.ts), which stops this host first and fails the run on any (#251).
 */
async function stopLeftovers(): Promise<void> {
  await recordLeft(dir);
  const left = await stopRunProcesses({ mark: crypto.randomUUID(), dir });
  writeFileSync(E2E_LAYOUT_LEFT, JSON.stringify(left.map(({ pid, command }) => ({ pid, command }))));
}

let stopping = false;
let stopMachine: (() => Promise<void>) | undefined;
/**
 * Exits 0 only when told to stop; a setup that failed, a doriface-host that stopped by itself (#1279) or a machine stop
 * that failed (#2586 review) exits non-zero.
 */
async function shutdown(code = 0): Promise<void> {
  if (stopping) return;
  let exitCode = code;
  stopping = true;
  host.kill("SIGTERM");
  await host.exited;
  await stopCore();
  try {
    await stopMachine?.();
  } catch (error) {
    // The rest of the teardown still runs: the leftovers check, the stopped word and the run dir's removal (#2527
    // review). The stop's failure still fails the run (#2586 review).
    console.error(error);
    exitCode = exitCode === 0 ? 1 : exitCode;
  }
  if (layout) {
    await stopLeftovers();
    // The run's teardown waits for this rather than for a fixed time: the host's own word that its cores are stopped,
    // what it left is recorded, and it is about to exit (#1412).
    writeFileSync(E2E_LAYOUT_STOPPED, JSON.stringify({ pid: process.pid }));
  }
  rmSync(savedEnv, { force: true });
  rmSync(dir, { recursive: true, force: true });
  process.exit(exitCode);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
// A killed run sends this host nothing: Playwright SIGKILLs what it started, so the core and the ports it holds would
// outlive the run and block the next one (#693). Watching the parent's identity, rather than waiting for a signal,
// lets it stop itself. Not ppid === 1: under a subreaper or a container init the host reparents to something else.
watchParentDeath(() => void shutdown());
try {
  if (layout) {
    const seeds = LAYOUT_TERMINALS.map((terminal) => terminal.seed);
    await runSeeds(hc, env, join(dir, "work", LAYOUT_DIR), seeds);
    // A capture needs no second machine, and adding one inside a container fails, so the capture command may skip it.
    if (process.env["E2E_SKIP_MACHINE"] !== "1") {
      stopMachine = await addMachine(hc, env, join(dir, "machine"), true, LAYOUT_MACHINE_SPEC);
    }
    writeSavedEnv(E2E_LAYOUT_ENV, { ...saved, ready: true });
  } else {
    const capture = process.env["CAPTURE"] === "1";
    if (capture) await seed(hc, env, join(dir, "work"));
    await seedMeshDoc(hc, session, env);
    if (process.env["E2E_SKIP_MACHINE"] !== "1") {
      stopMachine = await addMachine(hc, env, join(dir, "machine"), capture);
    }
    writeSavedEnv(E2E_HOST_ENV, { ...saved, ready: true });
  }
} catch (error) {
  console.error(`e2e host setup failed: ${String(error)}`);
  await shutdown(1);
}
const exitCode = await host.exited;
if (!stopping) {
  // doriface-host has already said why on stderr (a port in use, say); its exit code is passed on.
  console.error(`e2e host: doriface-host exited by itself (exit ${exitCode})`);
  await shutdown(exitCode === 0 ? 1 : exitCode);
}
