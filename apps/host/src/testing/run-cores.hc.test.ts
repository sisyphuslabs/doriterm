import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHcBin } from "./hc-session.ts";
import {
  recordLeft,
  RUN_MARK,
  runCores,
  runProcesses,
  signalProcess,
  stopRunProcesses,
  type TestRun,
} from "./run-cores.ts";

const encoder = new TextEncoder();

const newRun = (): TestRun => ({
  mark: crypto.randomUUID(),
  dir: realpathSync(mkdtempSync(join(tmpdir(), "dh-run-"))),
});

/**
 * Starts a core through `hc connect` on a scratch session in `run`'s dir and leaves it running. With `marked` false its
 * environment has no run mark, as a core launchd starts on macOS has none.
 */
async function startCore(run: TestRun, marked: boolean): Promise<string> {
  const dir = mkdtempSync(join(run.dir, "dh-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    HC_SESSION: "run-cores",
    HC_SOCKET: join(dir, "c.sock"),
    XDG_STATE_HOME: join(dir, "state"),
    XDG_RUNTIME_DIR: join(dir, "run"),
    [RUN_MARK]: run.mark,
  };
  if (!marked) delete env[RUN_MARK];
  const proc = Bun.spawn([resolveHcBin(), "connect", "--session", "run-cores"], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  proc.stdin.write(encoder.encode('{"jsonrpc":"2.0","id":1,"method":"server.status"}\n'));
  await proc.stdin.flush();
  const reader = proc.stdout.getReader();
  await reader.read();
  reader.releaseLock();
  void proc.stdin.end();
  await proc.exited;
  return join(dir, "c.sock");
}

async function serving(socket: string): Promise<boolean> {
  try {
    (await Bun.connect({ unix: socket, socket: { data: () => {} } })).end();
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && ["ECONNREFUSED", "ENOENT"].includes(String(error.code)))
      return false;
    throw error;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

test("a core a run left without its mark is found by the file it holds in the run's dir and stopped; another run's core is not touched", async () => {
  const [mine, other] = [newRun(), newRun()];
  try {
    const [socket, otherSocket] = await Promise.all([startCore(mine, false), startCore(other, true)]);
    const found = await runCores(mine);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((core) => core.where.startsWith(`holds ${mine.dir}/`))).toBe(true);
    const stopped = await stopRunProcesses(mine);
    expect(stopped.map((core) => core.pid).filter(alive)).toEqual([]);
    expect(await runCores(mine)).toEqual([]);
    expect(await serving(socket)).toBe(false);
    expect(await serving(otherSocket)).toBe(true);
  } finally {
    await Promise.all([stopRunProcesses(mine), stopRunProcesses(other)]);
    for (const run of [mine, other]) rmSync(run.dir, { recursive: true, force: true });
  }
}, 60_000);

test("a process carrying a run's mark is found by it and stopped", async () => {
  const run = newRun();
  try {
    // Bun, not /bin/sleep: macOS hides the environment of Apple platform binaries from ps -E (the next test's case).
    const script = `
      import { closeSync } from "node:fs";
      console.log(process.pid);
      closeSync(1);
      setTimeout(() => {}, 60_000);
    `;
    const marked = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, [RUN_MARK]: run.mark },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    // A process that was only just spawned has not finished its exec, and until it has, its environment reads as
    // empty: a scan then does not see the mark (#2404). Its own first line says it is past that.
    expect(Number((await new Response(marked.stdout).text()).trim())).toBe(marked.pid);
    expect((await runProcesses(run)).map((found) => found.pid)).toContain(marked.pid);
    expect((await stopRunProcesses(run)).map((found) => found.pid)).toContain(marked.pid);
    await marked.exited;
    expect(await runProcesses(run)).toEqual([]);
  } finally {
    await stopRunProcesses(run);
    rmSync(run.dir, { recursive: true, force: true });
  }
}, 60_000);

test("an unmarked grandchild stays owned after its parent exits on TERM (#1433)", async () => {
  const run = newRun();
  const script = `
    import { closeSync } from "node:fs";
    process.on("SIGTERM", () => {});
    console.log(process.pid);
    closeSync(1);
    setTimeout(() => {}, 30_000);
  `;
  const parent = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { closeSync } from "node:fs";
    const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(script)}], {
      env: {}, stdin: "ignore", stdout: "pipe", stderr: "ignore"
    });
    const pid = await new Response(child.stdout).text();
    console.log(pid.trim());
    closeSync(1);
    await child.exited;
  `,
    ],
    {
      env: { ...process.env, [RUN_MARK]: run.mark },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const child = Number((await new Response(parent.stdout).text()).trim());
  try {
    expect(child).toBeGreaterThan(0);
    expect((await runProcesses(run)).map((one) => one.pid)).toContain(child);
    const stopped = await stopRunProcesses(run);
    await parent.exited;
    expect(stopped.map((one) => one.pid)).toContain(child);
    expect(alive(child)).toBe(false);
    expect(await runProcesses(run)).toEqual([]);
  } finally {
    parent.kill("SIGKILL");
    await parent.exited;
    if (Number.isInteger(child) && child > 0) signalProcess(child, "SIGKILL");
    await stopRunProcesses(run);
    rmSync(run.dir, { recursive: true, force: true });
  }
}, 60_000);

test("processes the suite recorded as left are found and stopped whatever their program, with no mark", async () => {
  const run = newRun();
  // Two Apple platform binaries on macOS, whose environment ps -E never shows, below a parent that prints their pids.
  const parent = Bun.spawn(["/bin/sh", "-c", "/bin/sleep 60 & a=$!; /bin/sleep 60 & echo $a $!; wait"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  try {
    const reader = parent.stdout.getReader();
    const line = new TextDecoder().decode((await reader.read()).value);
    reader.releaseLock();
    const sleepers = line
      .trim()
      .split(" ")
      .map(Number)
      .toSorted((a, b) => a - b);
    await recordLeft(run.dir, parent.pid);
    expect((await runProcesses(run)).map((one) => one.pid).toSorted((a, b) => a - b)).toEqual(sleepers);
    const stopped = await stopRunProcesses(run);
    expect(stopped.map((one) => one.pid).toSorted((a, b) => a - b)).toEqual(sleepers);
    expect(sleepers.filter(alive)).toEqual([]);
    // Its children stopped, the parent's wait returns.
    await parent.exited;
    expect(await runProcesses(run)).toEqual([]);
  } finally {
    parent.kill();
    await stopRunProcesses(run);
    rmSync(run.dir, { recursive: true, force: true });
  }
}, 60_000);
