import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HcConnection } from "./connection.ts";
import { raceDeadline } from "./deadline.ts";
import type { StreamClose } from "./stream-close.ts";
import { ProcessLink } from "./process-link.ts";

const STEP_TIMEOUT_MS = 15_000;
const hcBin = process.env["HC_BIN"] ?? Bun.which("hc");
const scratch = await mkdtemp(join(tmpdir(), "df-"));

afterAll(() => rm(scratch, { recursive: true, force: true }));

function within<T>(promise: Promise<T>, what: string): Promise<T> {
  return raceDeadline(
    promise,
    { timeoutMs: STEP_TIMEOUT_MS },
    () => new Error(`${what} did not happen within ${STEP_TIMEOUT_MS} ms`),
  );
}

function spawnConnect(bin: string) {
  return Bun.spawn([bin, "connect"], {
    cwd: scratch,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: scratch,
      HC_SESSION: `doriface-test-${crypto.randomUUID().slice(0, 8)}`,
      // The default socket lives under XDG_RUNTIME_DIR/herdr-core/<session>.sock, which overruns the
      // 103-byte sun_path limit on macOS once TMPDIR is deep; a short explicit socket keeps it isolated.
      HC_SOCKET: join(scratch, "s.sock"),
      XDG_STATE_HOME: join(scratch, "state"),
      XDG_RUNTIME_DIR: join(scratch, "run"),
      XDG_CONFIG_HOME: join(scratch, "config"),
      // The test run's mark (apps/host/src/testing/run-cores.ts), so `bun run test` stops this core if a failure leaves it.
      DORIFACE_TEST_RUN: process.env["DORIFACE_TEST_RUN"],
    },
  });
}

describe("real herdr-core over hc connect", () => {
  test("runs a shell, attaches, sees its output, kills it and stops the core", async () => {
    if (hcBin === undefined || hcBin === null) {
      throw new Error("no herdr-core binary: set HC_BIN or put hc on PATH (CI installs hc 0.1.21)");
    }
    const child = spawnConnect(hcBin);
    const stderr = new Response(child.stderr).text();
    try {
      const connection = await within(HcConnection.open(new ProcessLink(child)), "hello");
      const status = await connection.call("server.status", {}, { timeoutMs: STEP_TIMEOUT_MS });
      expect(status.version).toBe(connection.hello.version);
      expect((await connection.call("terminal.list", {}, { timeoutMs: STEP_TIMEOUT_MS })).terminals).toEqual([]);

      const shell = await connection.call(
        "terminal.run",
        { argv: ["/bin/sh"], cwd: scratch, env: { PS1: "$ ", HOME: scratch } },
        { timeoutMs: STEP_TIMEOUT_MS },
      );
      const stream = await connection.attach({ terminal: shell.address, cols: 100, rows: 30 });
      const closed = new Promise<StreamClose>((resolve) => stream.onClose(resolve));
      const decoder = new TextDecoder();
      let screen = "";
      const printed = new Promise<string>((resolve) =>
        stream.onData((bytes) => {
          screen += decoder.decode(bytes, { stream: true });
          const line = screen.split(/\r?\n/).find((candidate) => candidate.trim() === "doriface-ok");
          if (line !== undefined) resolve(line.trim());
        }),
      );
      stream.write("echo doriface-ok\r");
      const line = await within(printed, "doriface-ok output");
      console.log(`hc ${connection.hello.version} ${shell.address} printed: ${line}`);
      expect(line).toBe("doriface-ok");

      const killed = await connection.call(
        "terminal.kill",
        { terminal: shell.address },
        { timeoutMs: STEP_TIMEOUT_MS },
      );
      expect(killed.state).toBe("finished");
      expect(await within(closed, "stream CLOSE")).toMatchObject({ by: "core", reason: "killed" });

      expect(await connection.call("server.stop", {}, { timeoutMs: STEP_TIMEOUT_MS })).toEqual({ stopped: true });
      expect(await within(child.exited, "hc connect exit")).toBe(0);
      if (!connection.closed) await within(new Promise((resolve) => connection.onClose(resolve)), "connection close");
      expect(connection.closed).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
      const errors = (await stderr).trim();
      if (errors !== "") console.error(`hc connect stderr: ${errors}`);
    }
  }, 60_000);
});
