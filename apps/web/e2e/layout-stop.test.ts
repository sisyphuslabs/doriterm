// The run's teardown stops the layout host this run started, waits for that host's exit, and reports a stop it could
// not confirm as infrastructure: none of it may fail a spec that never started one, and a slow stop may not read as a
// failed test (#1412).
import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FullConfig } from "@playwright/test";
import { E2E_LAYOUT_ENV, E2E_LAYOUT_LEFT, E2E_LAYOUT_STOPPED } from "./config.ts";
import leftoverHosts from "./leftover-hosts.ts";
import { writeSavedEnv } from "./saved-env.ts";

/** No worker slots: their hosts belong to the real suite, and these fixtures are the layout host's alone. */
const CONFIG = { workers: 0 } as unknown as FullConfig;

/**
 * The bound a test gives the teardown, well under the window the teardown uses in a real run: a fixture that ignores
 * SIGTERM makes any waiting visible as a slow test, not as a slow machine.
 */
const WITHIN_MS = 300;

/** How long the fixture may take to install its signal handlers: a signal before them ends it, as it would end any process. */
const READY_WITHIN_MS = 15_000;

/** The run id this process carries, as every host it starts records it (#1412): the runner makes it in run-ports.ts. */
const RUN = process.env["DORIFACE_E2E_RUN_ID"] ?? "";

const made: string[] = [];

function store(): string {
  const dir = mkdtempSync(join(tmpdir(), "dw-layout-stop-"));
  made.push(dir);
  return dir;
}

/** A process that ignores SIGTERM and never exits: a layout host slower to stop than any bound a test can wait. */
interface Stubborn {
  readonly pid: number;
  /** The signals it has been sent, if any. */
  readonly signals: () => string[];
  readonly stop: () => Promise<void>;
}

async function stubbornHost(): Promise<Stubborn> {
  const log = join(store(), "signals.log");
  const ready = join(store(), "ready");
  const child = Bun.spawn(
    [
      "bun",
      "-e",
      // No escapes and no arguments to misquote: it says when its handlers are in, records what it is sent in one
      // write, and never exits.
      [
        'const { writeFileSync } = require("node:fs");',
        'process.on("SIGTERM", () => writeFileSync(process.env.SIGNAL_LOG, "SIGTERM"));',
        'process.on("SIGINT", () => writeFileSync(process.env.SIGNAL_LOG, "SIGINT"));',
        'writeFileSync(process.env.READY_LOG, "ready");',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    ],
    { env: { ...process.env, SIGNAL_LOG: log, READY_LOG: ready }, stdout: "ignore", stderr: "inherit" },
  );
  for (let waited = 0; !existsSync(ready) && waited < READY_WITHIN_MS; waited += 20) {
    // oxlint-disable-next-line no-await-in-loop -- the fixture is inert until its handlers are in; nothing else waits
    await Bun.sleep(20);
  }
  if (!existsSync(ready)) throw new Error(`the stubborn host was not ready within ${READY_WITHIN_MS} ms`);
  return {
    pid: child.pid,
    signals: () => (existsSync(log) ? [readFileSync(log, "utf8")] : []),
    stop: async () => {
      child.kill("SIGKILL");
      await child.exited;
    },
  };
}

/** The layout host's saved environment, as e2e/host.ts saves it when a host starts: the record of who started it. */
function savedLayoutHost(pid: number, run: string): void {
  writeSavedEnv(E2E_LAYOUT_ENV, { hc: join(store(), "hc"), env: { HC_SESSION: "layout" }, pid, run });
}

/**
 * A layout host that stops on SIGTERM as e2e/host.ts does: it starts a process of its own, records it as one it left
 * (the #251 leftover check) and exits. Returns its pid, and the pid of the process it left once it has gone.
 */
async function leavingHost(): Promise<{ readonly pid: number; readonly left: () => number }> {
  const ready = join(store(), "ready");
  const leaked = join(store(), "leaked");
  const child = Bun.spawn(
    [
      "bun",
      "-e",
      [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        'process.on("SIGTERM", () => {',
        '  const left = spawn("bun", ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        "  writeFileSync(process.env.LEAKED, String(left.pid));",
        '  writeFileSync(process.env.LEFT_FILE, JSON.stringify([{ pid: left.pid, command: "hc-core left behind" }]));',
        '  writeFileSync(process.env.STOPPED_FILE, "stopped");',
        "  process.exit(0);",
        "});",
        'writeFileSync(process.env.READY_LOG, "ready");',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    ],
    {
      env: {
        ...process.env,
        LEFT_FILE: E2E_LAYOUT_LEFT,
        READY_LOG: ready,
        LEAKED: leaked,
        STOPPED_FILE: E2E_LAYOUT_STOPPED,
      },
      stdout: "ignore",
      stderr: "inherit",
    },
  );
  for (let waited = 0; !existsSync(ready) && waited < READY_WITHIN_MS; waited += 20) {
    // oxlint-disable-next-line no-await-in-loop -- the fixture is inert until its handlers are in; nothing else waits
    await Bun.sleep(20);
  }
  if (!existsSync(ready)) throw new Error(`the leaving host was not ready within ${READY_WITHIN_MS} ms`);
  return {
    pid: child.pid,
    left: () => Number(readFileSync(leaked, "utf8")),
  };
}

/** Runs the run's teardown as Playwright does, and returns the infrastructure lines it printed. */
async function teardown(): Promise<string[]> {
  const logged: string[] = [];
  const errors = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  try {
    await leftoverHosts(CONFIG, { withinMs: WITHIN_MS });
  } finally {
    errors.mockRestore();
  }
  return logged;
}

afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
  rmSync(E2E_LAYOUT_ENV, { force: true });
  rmSync(E2E_LAYOUT_LEFT, { force: true });
  rmSync(E2E_LAYOUT_STOPPED, { force: true });
});

test("a run that never started the layout host leaves it alone, however slow it is to stop", async () => {
  const host = await stubbornHost();
  try {
    // Another run started this host: this run's teardown has nothing of its own to stop, and must not touch its pid.
    savedLayoutHost(host.pid, "a-run-that-is-not-this-one");
    const started = Date.now();
    expect(await teardown()).toEqual([]);
    expect(host.signals()).toEqual([]);
    expect(Date.now() - started).toBeLessThan(10_000);
  } finally {
    await host.stop();
  }
}, 120_000);

test("a layout host this run started, that never exits, is reported as infrastructure, not as a failed test", async () => {
  const host = await stubbornHost();
  try {
    savedLayoutHost(host.pid, RUN);
    const logged = await teardown();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toStartWith("E2E_INFRA_TIMEOUT: ");
    expect(logged[0]).toContain(`pid ${host.pid}`);
    expect(logged[0]).toContain("test results are reported separately");
    // The teardown never sees test results, so it must not claim any test did or did not fail: the message says
    // infrastructure and points the reader at the results instead.
    expect(logged[0]).not.toContain("no test failed");
    // The record the fixtures write is this run's: with an empty id the check above would compare two blanks.
    expect(RUN).not.toBe("");
  } finally {
    await host.stop();
  }
}, 120_000);

test("a layout host that leaves a process behind still fails the run, naming it (#251)", async () => {
  const host = await leavingHost();
  let leftover = 0;
  try {
    savedLayoutHost(host.pid, RUN);
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    let thrown: unknown;
    try {
      await leftoverHosts(CONFIG, { withinMs: 30_000 });
    } catch (error) {
      thrown = error;
    } finally {
      errors.mockRestore();
      leftover = host.left();
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toContain("hc processes left by the layout host");
    expect(message).toContain(`pid ${leftover}: `);
  } finally {
    if (leftover > 0) process.kill(leftover, "SIGKILL");
  }
}, 120_000);

/**
 * A layout host whose machine stop failed, as e2e/host.ts reports one: it still finishes its teardown (nothing left, the
 * stopped word written) but says in that word that the machine's stop threw.
 */
async function failedMachineStopHost(): Promise<number> {
  const ready = join(store(), "ready");
  const child = Bun.spawn(
    [
      "bun",
      "-e",
      [
        'const { renameSync, writeFileSync } = require("node:fs");',
        'process.on("SIGTERM", () => {',
        '  writeFileSync(process.env.LEFT_FILE, "[]");',
        "  // Written whole and renamed into place, as e2e/host.ts writes it: the teardown reads it the moment it appears.",
        '  const word = process.env.STOPPED_FILE + ".tmp";',
        '  writeFileSync(word, JSON.stringify({ pid: process.pid, machineStop: "core exited late" }));',
        "  renameSync(word, process.env.STOPPED_FILE);",
        "  process.exit(1);",
        "});",
        'writeFileSync(process.env.READY_LOG, "ready");',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    ],
    {
      env: { ...process.env, LEFT_FILE: E2E_LAYOUT_LEFT, READY_LOG: ready, STOPPED_FILE: E2E_LAYOUT_STOPPED },
      stdout: "ignore",
      stderr: "inherit",
    },
  );
  for (let waited = 0; !existsSync(ready) && waited < READY_WITHIN_MS; waited += 20) {
    // oxlint-disable-next-line no-await-in-loop -- the fixture is inert until its handlers are in; nothing else waits
    await Bun.sleep(20);
  }
  if (!existsSync(ready)) throw new Error(`the failing host was not ready within ${READY_WITHIN_MS} ms`);
  return child.pid;
}

test("a layout host whose machine stop failed fails the run, naming the failure (#2594 review)", async () => {
  savedLayoutHost(await failedMachineStopHost(), RUN);
  const errors = spyOn(console, "error").mockImplementation(() => undefined);
  let thrown: unknown;
  try {
    await leftoverHosts(CONFIG, { withinMs: 30_000 });
  } catch (error) {
    thrown = error;
  } finally {
    errors.mockRestore();
  }
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown instanceof Error ? thrown.message : "").toContain(
    "the layout host's machine stop failed: core exited late",
  );
}, 120_000);
