import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHcSession, type HcSession } from "@doriface/host/testing";
import { stopLeftUnder } from "@doriface/host/testing/run-dir";
import { addMachine, DEMO_MACHINE, replyPid, running, viaCommand } from "./machine.ts";

let dialer: HcSession | undefined;
let root: string | undefined;

afterEach(async () => {
  await dialer?.dispose();
  if (root !== undefined) {
    await stopLeftUnder(root);
    rmSync(root, { recursive: true, force: true });
  }
  dialer = undefined;
  root = undefined;
});

/** Resolves once `file` exists in `dir`, as the filesystem reports it; rejects after `withinMs`. */
function appears(dir: string, file: string, withinMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const watcher = watch(dir, () => {
      if (existsSync(join(dir, file))) finish();
    });
    const bound = setTimeout(() => {
      watcher.close();
      reject(new Error(`${file} did not appear in ${dir} within ${withinMs} ms`));
    }, withinMs);
    function finish(): void {
      clearTimeout(bound);
      watcher.close();
      resolve();
    }
    if (existsSync(join(dir, file))) finish();
  });
}

/** A dial as the dialing core makes one: hc runs the machine's `--via` command with its own connect as the argument. */
async function dialOnce(hc: string, via: string): Promise<number> {
  const line = Bun.spawn(["sh", "-c", `${via} 'exec "${hc}" connect'`], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  // A refused line can stop reading before the hello is written. The pipe is closed then (EPIPE), and the line's exit
  // code is still the answer (#2402).
  try {
    line.stdin.write('{"jsonrpc":"2.0","id":0,"method":"hello","params":{}}\n');
    await line.stdin.flush();
    await line.stdin.end();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EPIPE")) throw error;
  }
  return line.exited;
}

/** The pid of the core `env` reaches, as its server.status names it. */
async function corePid(hc: string, env: Readonly<Record<string, string | undefined>>): Promise<number | undefined> {
  const status = Bun.spawn([hc, "connect"], { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const replies = new Response(status.stdout).text();
  status.stdin.write('{"jsonrpc":"2.0","id":1,"method":"server.status"}\n');
  await status.stdin.flush();
  void status.stdin.end();
  await status.exited;
  return replyPid(await replies, 1);
}

test("a line of hc connect's output that is not JSON is no reply, so the pid is still read from the reply after it", () => {
  const output = 'error: socket path is too long\n{"jsonrpc":"2.0","id":1,"result":{"pid":4242}}\n';
  expect(replyPid(output, 1)).toBe(4242);
  expect(replyPid('{"error":"socket path is too long"}\n', 1)).toBeUndefined();
});

test("the machine's stop resolves once its core has exited, not once it has answered (#2525)", async () => {
  dialer = createHcSession("machine-stop-exit");
  root = mkdtempSync(join(tmpdir(), "dw-machine-"));
  const spec = { ...DEMO_MACHINE, dir: join(root, "files") };
  const stop = await addMachine(dialer.hc, { ...dialer.env }, join(root, "machine"), false, spec);
  const { env: own } = JSON.parse(readFileSync(join(spec.dir, "env.json"), "utf8")) as {
    readonly env: Readonly<Record<string, string>>;
  };
  const pid = await corePid(dialer.hc, { ...dialer.env, ...own });
  expect(pid).toBeNumber();
  // The teardown's order (fake-relay-host.ts): the dialing core first, so nothing dials the machine back up after it.
  await dialer.dispose();
  await stop();
  // Read the moment the stop resolves: a core still on its way out is what a check or a late dial would then meet.
  expect(pid === undefined ? true : running(pid)).toBe(false);
}, 60_000);

test("a dial that reaches an added machine after its stop is refused, so the stop leaves no core behind (#2142)", async () => {
  dialer = createHcSession("machine-late-dial");
  root = mkdtempSync(join(tmpdir(), "dw-machine-"));
  const spec = { ...DEMO_MACHINE, dir: join(root, "files") };
  const stop = await addMachine(dialer.hc, { ...dialer.env }, join(root, "machine"), false, spec);
  const { env: own } = JSON.parse(readFileSync(join(spec.dir, "env.json"), "utf8")) as {
    readonly env: Readonly<Record<string, string>>;
  };
  // The teardown's order (fake-relay-host.ts): the dialing core first, then the machine.
  await dialer.dispose();
  await stop();
  // A line the dialing core started before it stopped can still run after the machine's stop. hc connect starts a core
  // that is not running, so a dial let through here would start the machine's core again, with nothing left to stop it.
  expect(await dialOnce(dialer.hc, viaCommand(own, spec))).not.toBe(0);
  expect(await stopLeftUnder(join(root, "machine"))).toEqual([]);
}, 60_000);
test("a slow dial that passed the check before the machine stopped is refused once it wakes (#2158)", async () => {
  dialer = createHcSession("machine-slow-dial");
  root = mkdtempSync(join(tmpdir(), "dw-machine-"));
  const spec = { ...DEMO_MACHINE, dir: join(root, "files") };
  const stop = await addMachine(dialer.hc, { ...dialer.env }, join(root, "machine"), false, spec);
  const { env: own } = JSON.parse(readFileSync(join(spec.dir, "env.json"), "utf8")) as {
    readonly env: Readonly<Record<string, string>>;
  };
  // A dial on a loaded runner: past the checks, it is held before its line starts (the `slow` switch).
  writeFileSync(join(spec.dir, "switch"), "slow");
  const dialed = dialOnce(dialer.hc, viaCommand(own, spec));
  await appears(spec.dir, "dialing", 10_000);
  // The teardown runs while that dial is held: the dialing core, then the machine.
  await dialer.dispose();
  await stop();
  expect(await dialed).not.toBe(0);
  expect(await stopLeftUnder(join(root, "machine"))).toEqual([]);
}, 60_000);
