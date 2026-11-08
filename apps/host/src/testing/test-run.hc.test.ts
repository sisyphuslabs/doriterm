import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_DIR, RUN_MARK, runProcesses, stopRunProcesses } from "./run-cores.ts";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");

test("bare bun test reaps a child and grandchild under a custom TMPDIR (#1433)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dt-tree-"));
  const run = { dir, mark: crypto.randomUUID() };
  const env: Record<string, string | undefined> = { ...process.env, TMPDIR: dir, [RUN_MARK]: run.mark };
  delete env[RUN_DIR];
  const suite = Bun.spawn(
    [process.execPath, "test", "--timeout", "10000", "./apps/host/src/testing/leak-tree.fixture.ts"],
    { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" },
  );
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(suite.stdout).text(),
      new Response(suite.stderr).text(),
      suite.exited,
    ]);
    const output = stdout + stderr;
    const line = /^LEFT_TREE (\[.*\])$/m.exec(output)?.[1];
    expect(line, output).toBeDefined();
    const pids: unknown = JSON.parse(line ?? "null");
    if (!Array.isArray(pids) || !pids.every((pid): pid is number => typeof pid === "number"))
      throw new Error(`no child pids: ${output}`);
    // Capture before the finally reaps a regressed fixture, so cleanup cannot manufacture the assertion.
    const left = pids.filter(alive);
    console.log(`TREE_COUNTS spawned=${pids.length} remaining=${left.length}`);
    expect(left).toEqual([]);
    expect(code, output).toBe(1);
    expect(output).toContain("processes outlived the test run (now stopped)");
    expect(await runProcesses(run)).toEqual([]);
  } finally {
    suite.kill();
    await suite.exited;
    await stopRunProcesses(run);
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

async function refused(socket: string): Promise<boolean> {
  try {
    (await Bun.connect({ unix: socket, socket: { data: () => {} } })).end();
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && ["ECONNREFUSED", "ENOENT"].includes(String(error.code)))
      return true;
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

interface Leaked {
  readonly output: string;
  readonly code: number;
  /** The pids the runner reported it stopped. */
  readonly stopped: readonly number[];
  /** The socket of the core the fixture left. */
  readonly socket: string;
}

/** Runs `fixture` through `bun run test`'s runner; the fixture leaves a core in the run's dir and says where. */
async function runLeaking(fixture: string, leak: string): Promise<Leaked> {
  const runner = Bun.spawn([process.execPath, "apps/host/scripts/test-run.ts", fixture], {
    cwd: ROOT,
    env: { ...process.env, LEAK_DIR: leak },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(runner.stdout).text(),
    new Response(runner.stderr).text(),
    runner.exited,
  ]);
  const output = stdout + stderr;
  const stopped = [...output.matchAll(/^ {2}pid (\d+): /gm)].map((match) => Number(match[1]));
  return { output, code, stopped, socket: readFileSync(join(leak, "socket"), "utf8") };
}

test("bun run test's runner fails a run whose tests pass but leave a core, and stops that core", async () => {
  const leak = mkdtempSync(join(tmpdir(), "dh-leak-"));
  try {
    const run = await runLeaking("./apps/host/src/testing/leak-one-core.fixture.ts", leak);
    expect(run.output).toContain("1 pass");
    expect(run.output).toContain("processes outlived the test run (now stopped): 1");
    expect(run.code).toBe(1);
    expect(run.stopped.filter(alive)).toEqual([]);
    expect(await refused(run.socket)).toBe(true);
  } finally {
    rmSync(leak, { recursive: true, force: true });
  }
}, 60_000);

test("bun run test's runner fails a run that leaves a process which starts a core after bun test exits, and leaves no core", async () => {
  const leak = mkdtempSync(join(tmpdir(), "dh-late-"));
  try {
    const run = await runLeaking("./apps/host/src/testing/leak-late-core.fixture.ts", leak);
    expect(run.output).toContain("1 pass");
    expect(run.output).toContain("outlived the test run (now stopped)");
    expect(run.code).toBe(1);
    // The runner returns only once no process of the run is left, so nothing can start this core any more.
    expect(run.stopped.length).toBeGreaterThan(0);
    expect(run.stopped.filter(alive)).toEqual([]);
    expect(await refused(run.socket)).toBe(true);
  } finally {
    rmSync(leak, { recursive: true, force: true });
  }
}, 60_000);
