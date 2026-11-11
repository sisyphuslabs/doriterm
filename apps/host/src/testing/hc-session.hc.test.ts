import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHcSession, type HcSession, stopLeftoverCores } from "./hc-session.ts";

const line = (method: string): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method })}\n`);

/** hc connect starts a stopped core again, as a dialer's reconnect does. */
async function startAgain(session: HcSession): Promise<void> {
  const again = session.connect();
  await again.write(line("server.status"));
  await again.reader.line();
  again.end();
  await again.exited;
}

async function serving(session: HcSession): Promise<boolean> {
  const socket = session.env["HC_SOCKET"];
  if (socket === undefined) throw new Error("no HC_SOCKET");
  try {
    (await Bun.connect({ unix: socket, socket: { data: () => {} } })).end();
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && ["ECONNREFUSED", "ENOENT"].includes(String(error.code)))
      return false;
    throw error;
  }
}

test("the guard's sweep reports a core started again after dispose, and stops it", async () => {
  const session = createHcSession("guard");
  const socket = session.env["HC_SOCKET"];
  if (socket === undefined) throw new Error("no HC_SOCKET");
  await session.dispose();
  await startAgain(session);
  // Held across the sweep: only the core itself, stopping, closes it. The sweep removes the socket's dir, so a fresh
  // connect afterwards would be refused whether or not the core still runs.
  const closed = Promise.withResolvers<void>();
  let open = true;
  const held = await Bun.connect({
    unix: socket,
    socket: {
      data: () => {},
      end: (s) => {
        s.end();
      },
      close: () => {
        open = false;
        closed.resolve();
      },
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stillRunning = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("the core never closed the held connection: it still runs")), 10_000);
  });
  try {
    expect(await stopLeftoverCores([session])).toEqual([session.name]);
    await Promise.race([closed.promise, stillRunning]);
    expect(await stopLeftoverCores([session])).toEqual([]);
  } finally {
    clearTimeout(timer);
    if (open) {
      held.write(line("server.stop"));
      await closed.promise;
    }
  }
}, 30_000);

test("disposing a session whose core never started spawns nothing, so a missing hc fails no teardown (#1538)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dh-missing-"));
  const before = process.env["HC_BIN"];
  process.env["HC_BIN"] = join(dir, "no-such-hc");
  try {
    const session = createHcSession("never-started");
    // No core serves this session: stopping one would spawn hc, which is not there.
    await session.dispose();
    expect(await serving(session)).toBe(false);
  } finally {
    if (before === undefined) delete process.env["HC_BIN"];
    else process.env["HC_BIN"] = before;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a test's sweep of its own sessions does not report another file's core that still serves (#261)", async () => {
  // Another test file's scratch session, its core started again after dispose: registered and serving when this
  // test sweeps. That file's own sweep, or the preloaded guard at the end of the run, owns it.
  const other = createHcSession("other-file");
  await other.dispose();
  await startAgain(other);
  const session = createHcSession("guard-own");
  await session.dispose();
  await startAgain(session);
  const swept = await stopLeftoverCores([session]);
  const otherServing = await serving(other);
  await stopLeftoverCores([other]);
  expect(swept).toEqual([session.name]);
  expect(otherServing).toBe(true);
  expect(await serving(other)).toBe(false);
}, 30_000);
