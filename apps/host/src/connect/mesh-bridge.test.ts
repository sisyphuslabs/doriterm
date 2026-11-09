import type { ByteLink } from "@doriface/crypto";
import { afterEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LineGrant } from "../mesh/line-grants.ts";
import { type LineSocket, listenLineSocket } from "../mesh/line-socket.ts";
import { meshProgram } from "../mesh/program.ts";
import { meshVia, shellQuote } from "../mesh/via.ts";
import { LINE_SOCKET_NAME } from "./mesh-bridge.ts";

/** The hostId is only a shape here; the line is never dialed. */
const HOST_ID = "a".repeat(25) + "a";

/** The command herdr appends to a via; the bridge ignores it, as it ignores every extra positional. */
const HC_LINE = `sh -c 'p=$(command -v herdr-core) || p=$HOME/.local/bin/herdr-core; exec "$p" connect'`;

const within = async <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
  const { promise: expired, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms / 1000} s`)), ms);
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
};

/** Waits for a process that is not this test's child to be gone; the bridge checks its caller every 250 ms. */
const gone = async (pid: number): Promise<void> => {
  if (!alive(pid)) return;
  await Bun.sleep(25);
  await gone(pid);
};

/** Spawns the bridge the way herdr does: through the pinned `via`, under a shell that execs it. */
function spawnBridge(dir: string): Subprocess<"pipe", "pipe", "pipe"> {
  const via = meshVia(meshProgram(dir), dir, HOST_ID);
  return Bun.spawn(["sh", "-c", `${via} "$1"`, "sh", HC_LINE], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

/**
 * Spawns the bridge under a shell that stays its parent (as a herdr core is) and writes the bridge's pid to
 * `bridge.pid`, so a test can kill the caller and follow that exact process.
 */
function spawnUnderShell(dir: string, { input = "" } = {}): Subprocess<"pipe", "pipe", "pipe"> {
  const via = meshVia(meshProgram(dir), dir, HOST_ID);
  const pidFile = shellQuote(join(dir, "bridge.pid"));
  const from = input === "" ? "" : ` < ${shellQuote(input)}`;
  return Bun.spawn(
    ["sh", "-c", `${via} "$1"${from} & child=$!; printf '%s' "$child" > ${pidFile}; wait`, "sh", HC_LINE],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

interface Fixture {
  readonly dir: string;
  readonly socket: LineSocket;
  readonly children: Subprocess<"pipe", "pipe", "pipe">[];
  readonly pids: number[];
  readonly cleanup: (() => void)[];
}

let fixture: Fixture | undefined;

afterEach(async () => {
  if (fixture === undefined) return;
  for (const pid of fixture.pids) if (alive(pid)) process.kill(pid, "SIGKILL");
  await Promise.all(
    fixture.children.map(async (child) => {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited.catch(() => undefined);
    }),
  );
  for (const close of fixture.cleanup) close();
  fixture.socket.stop();
  rmSync(fixture.dir, { recursive: true, force: true });
  fixture = undefined;
});

async function served(grant: (hostId: string) => Promise<LineGrant>): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "mesh-bridge-"));
  const socket = await listenLineSocket({ path: join(dir, LINE_SOCKET_NAME), grant, log: () => {} });
  const made = {
    dir,
    socket,
    children: [] as Subprocess<"pipe", "pipe", "pipe">[],
    pids: [] as number[],
    cleanup: [] as (() => void)[],
  };
  fixture = made;
  return made;
}

describe("connect --mesh: a bridge lives exactly as long as its caller's line", () => {
  test("a bridge whose caller is gone gives up instead of waiting for a host that never answers", async () => {
    const asked = Promise.withResolvers<string>();
    const line = await served((hostId) => {
      asked.resolve(hostId);
      // The host is dialing the member and has not answered this bridge yet.
      return new Promise(() => {});
    });
    const shell = spawnUnderShell(line.dir);
    line.children.push(shell);
    expect(await within(asked.promise, 5_000, "the bridge asking for a line")).toBe(HOST_ID);
    const pid = Number(readFileSync(join(line.dir, "bridge.pid"), "utf8"));
    expect(pid).toBeGreaterThan(0);
    line.pids.push(pid);
    expect(alive(pid)).toBe(true);

    // The herdr core that started this bridge goes away while the host is still dialing: the bridge is orphaned.
    shell.kill("SIGKILL");
    await shell.exited;

    await within(gone(pid), 3_000, "the orphaned bridge exiting");
    expect(alive(pid)).toBe(false);
  });

  test("a bridge whose caller is gone while its line is open ends instead of holding the line", async () => {
    const opened = Promise.withResolvers<void>();
    const link: ByteLink = {
      send: () => {},
      onData: () => {
        opened.resolve();
        return () => {};
      },
      // The member's end never closes: the line stays open for as long as the bridge holds it.
      onClose: () => () => {},
      close: () => {},
    };
    const line = await served(() => Promise.resolve({ ok: true, link }));
    // The bridge reads a FIFO this test holds open (read-write, so neither open blocks): the caller's death closes no
    // input of the bridge's, so no EOF can end it and only noticing the orphaning can.
    const fifo = join(line.dir, "input");
    Bun.spawnSync(["mkfifo", fifo]);
    const held = openSync(fifo, "r+");
    const shell = spawnUnderShell(line.dir, { input: fifo });
    line.children.push(shell);
    line.cleanup.push(() => closeSync(held));
    await within(opened.promise, 5_000, "the bridge taking up the granted line");
    const pid = Number(readFileSync(join(line.dir, "bridge.pid"), "utf8"));
    expect(pid).toBeGreaterThan(0);
    line.pids.push(pid);
    expect(alive(pid)).toBe(true);

    // The caller dies with the line open; this test still holds the bridge's input, so no EOF can end it.
    shell.kill("SIGKILL");
    await shell.exited;

    await within(gone(pid), 3_000, "the orphaned bridge with an open line exiting");
    expect(alive(pid)).toBe(false);
  });

  test("a live caller's bytes reach the granted line, and closing its input ends the bridge", async () => {
    const received = Promise.withResolvers<string>();
    let text = "";
    const listeners = new Set<(error: Error | undefined) => void>();
    const link: ByteLink = {
      send: (bytes) => {
        text += new TextDecoder().decode(bytes);
        if (text.includes("hello through the line\n")) received.resolve(text);
      },
      onData: () => () => {},
      onClose: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: () => {
        for (const listener of listeners) listener(undefined);
        listeners.clear();
      },
    };
    const line = await served(() => Promise.resolve({ ok: true, link }));
    const bridge = spawnBridge(line.dir);
    line.children.push(bridge);
    line.pids.push(bridge.pid);
    bridge.stdin.write("hello through the line\n");
    await bridge.stdin.flush();

    expect(await within(received.promise, 5_000, "the line receiving the bytes")).toBe("hello through the line\n");

    bridge.stdin.end();
    const code = await within(bridge.exited, 3_000, "the bridge exiting when its caller's input closed");
    expect(code).toBe(0);
    expect(alive(bridge.pid)).toBe(false);
  });
});
