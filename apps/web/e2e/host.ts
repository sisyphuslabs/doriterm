// Starts doriface-host in loopback dev mode on a scratch hc session; stops the core and deletes its state on exit.
// `bun e2e/host.ts layout` starts the layout spec's host instead: long names, titles and paths on another port.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_HOST_ENV, E2E_HOST_PORT, E2E_LAYOUT_PORT, E2E_TOKEN } from "./config.ts";
import { LAYOUT_CORE, LAYOUT_DIR, LAYOUT_MACHINE_SPEC, LAYOUT_TERMINALS } from "./layout-seed.ts";
import { addMachine, runSeeds } from "./machine.ts";
import { seedMeshDoc } from "./mesh-doc.ts";
import { seed } from "./seed.ts";

const layout = process.argv[2] === "layout";
const port = layout ? E2E_LAYOUT_PORT : E2E_HOST_PORT;

const hc = process.env["HC_BIN"] || Bun.which("hc");
if (hc === null || hc === undefined || hc === "") throw new Error("set HC_BIN to an hc 0.1.17 binary");
const dir = mkdtempSync(join(tmpdir(), "dw-"));
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
  SHELL: "/bin/sh",
  PS1: "$ ",
  ENV: "",
  BASH_SILENCE_DEPRECATION_WARNING: "1",
};
const coreDir = join(dir, "state", "herdr-core", session);
mkdirSync(coreDir, { recursive: true });
writeFileSync(
  join(coreDir, "core.json"),
  JSON.stringify({ id: crypto.randomUUID().replace(/-/g, ""), name: layout ? LAYOUT_CORE : "studio" }),
);
// Saved before the host can answer /healthz, so no spec reads a missing file or one a killed run left behind.
// Only the main host owns it: the layout host runs beside it and must not overwrite or delete it.
if (!layout) writeFileSync(E2E_HOST_ENV, JSON.stringify({ hc, env: own }));
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

let stopping = false;
let stopMachine: (() => Promise<void>) | undefined;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  host.kill("SIGTERM");
  await host.exited;
  await stopCore();
  await stopMachine?.();
  if (!layout) rmSync(E2E_HOST_ENV, { force: true });
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
try {
  if (layout) {
    const seeds = LAYOUT_TERMINALS.map((terminal) => terminal.seed);
    await runSeeds(hc, env, join(dir, "work", LAYOUT_DIR), seeds);
    stopMachine = await addMachine(hc, env, join(dir, "machine"), true, LAYOUT_MACHINE_SPEC);
  } else {
    const capture = process.env["CAPTURE"] === "1";
    if (capture) await seed(hc, env, join(dir, "work"));
    await seedMeshDoc(hc, session, env);
    stopMachine = await addMachine(hc, env, join(dir, "machine"), capture);
  }
} catch (error) {
  console.error(`e2e host setup failed: ${String(error)}`);
  await shutdown();
}
await host.exited;
if (!stopping) await shutdown();
