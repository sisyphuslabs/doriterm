import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { E2E_LAYOUT_ENV } from "./config.ts";
import { stopLayoutHost } from "./leftover-hosts.ts";
import { readSavedEnv, readSavedEnvIfWhole } from "./saved-env.ts";

const HOST_SCRIPT = join(import.meta.dir, "host.ts");
const READY_WITHIN_MS = 90_000;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Starts the layout host as Playwright's webServer does, and returns its dir once it has finished setting up. */
async function startLayoutHost(): Promise<{ readonly host: Bun.Subprocess; readonly dir: string }> {
  // The ports config.ts picked for this process: the host must save its file where E2E_LAYOUT_ENV points.
  const host = Bun.spawn(["bun", HOST_SCRIPT, "layout"], {
    env: { ...process.env },
    stdout: "ignore",
    stderr: "inherit",
  });
  const deadline = Date.now() + READY_WITHIN_MS;
  for (;;) {
    const saved = readSavedEnvIfWhole(E2E_LAYOUT_ENV);
    if (saved?.pid === host.pid && saved.ready === true) break;
    if (host.exitCode !== null) throw new Error(`the layout host exited during setup (${host.exitCode})`);
    if (Date.now() > deadline) throw new Error(`the layout host was not ready within ${READY_WITHIN_MS} ms`);
    // oxlint-disable-next-line no-await-in-loop -- the host saves its file as it goes; read it again until it is ready
    await Promise.race([host.exited, Bun.sleep(200)]);
  }
  return { host, dir: dirname(readSavedEnv(E2E_LAYOUT_ENV).env["XDG_STATE_HOME"] ?? "") };
}

/** Starts a core of a session in `dir`, as a layout host that forgot to stop one leaves it; returns its pid. */
async function leakCore(dir: string): Promise<number> {
  const hc = process.env["HC_BIN"] || Bun.which("hc") || "hc";
  const env = {
    ...process.env,
    HC_SESSION: "leaked",
    HC_SOCKET: join(dir, "leaked.sock"),
    XDG_STATE_HOME: join(dir, "leaked-state"),
    XDG_RUNTIME_DIR: join(dir, "leaked-run"),
  };
  const control = Bun.spawn([hc, "connect", "--session", "leaked"], { env, stdin: "pipe", stdout: "pipe" });
  control.stdin.write('{"jsonrpc":"2.0","id":1,"method":"server.status"}\n');
  await control.stdin.flush();
  const reader = control.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  void control.stdin.end();
  await control.exited;
  const reply = new TextDecoder().decode(value).split("\n")[0] ?? "";
  const result: unknown = Reflect.get(JSON.parse(reply) as object, "result");
  const pid = typeof result === "object" && result !== null ? Number(Reflect.get(result, "pid")) : Number.NaN;
  if (!Number.isInteger(pid)) throw new Error(`server.status answered no pid: ${reply}`);
  return pid;
}

test("a layout host that leaves a core running fails the teardown, which names it and leaves it stopped (#251)", async () => {
  const { host, dir } = await startLayoutHost();
  try {
    const leaked = await leakCore(dir);
    expect(alive(leaked)).toBe(true);

    const report = await stopLayoutHost();
    await host.exited;
    expect(report.infra).toEqual([]);
    expect(report.left).toHaveLength(1);
    expect(report.left[0]).toStartWith(`pid ${leaked}: `);
    expect(report.left[0]).not.toContain("HC_SOCKET");
    expect(alive(leaked)).toBe(false);
  } finally {
    host.kill("SIGTERM");
    await host.exited;
  }
}, 180_000);

test("a layout host that stops its cores leaves the teardown nothing to report", async () => {
  const { host } = await startLayoutHost();
  try {
    expect(await stopLayoutHost()).toEqual({ left: [], infra: [], failed: [] });
  } finally {
    host.kill("SIGTERM");
    await host.exited;
  }
}, 180_000);
