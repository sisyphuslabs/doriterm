import { encodeFrame, FrameKind, RPC_CHANNEL } from "@doriface/protocol";
import { onTestFinished } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ByteReader } from "./byte-reader.ts";

const encoder = new TextEncoder();

/** The first line every framed client sends. */
export const HELLO = encoder.encode('{"jsonrpc":"2.0","id":0,"method":"hello","params":{"framed":true}}\n');

export function rpcFrame(id: number, method: string): Uint8Array {
  return encodeFrame(RPC_CHANNEL, FrameKind.Data, encoder.encode(JSON.stringify({ jsonrpc: "2.0", id, method })));
}

export function resolveHcBin(): string {
  const bin = process.env["HC_BIN"] || Bun.which("hc");
  if (bin === null || bin === undefined || bin === "") {
    throw new Error("herdr-core is required: set HC_BIN to an hc 0.1.21 binary or put hc on PATH");
  }
  return bin;
}

export interface HcSession {
  readonly hc: string;
  readonly name: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Spawns `hc connect --session <name>` directly, with its stdout fed to `reader`. */
  connect(): DirectConnection;
  /**
   * Stops this session's core, if one serves, and removes its dir; `stopLeftoverCores` still checks it for a core started
   * again.
   */
  dispose(): Promise<void>;
}

export interface DirectConnection {
  readonly reader: ByteReader;
  readonly exited: Promise<number>;
  write(bytes: Uint8Array): Promise<void>;
  end(): void;
}

async function stopCore(session: HcSession): Promise<void> {
  const control = session.connect();
  await control.write(encoder.encode('{"jsonrpc":"2.0","id":1,"method":"server.stop"}\n'));
  await control.reader.line();
  control.end();
  // The core closes the connection as it shuts down, which ends this hc connect.
  await control.exited;
}

interface Scratch {
  readonly session: HcSession;
  readonly dir: string;
  readonly socket: string;
  /** Where the session was made: the caller's frames, so a core it leaves names the test that made it (#441). */
  readonly made: string;
  disposed: boolean;
}

/** The frames of the code that called createHcSession, outside this file: the test (or helper) that made a session. */
function madeAt(): string {
  const frames = (new Error().stack ?? "").split("\n").slice(1);
  const callers = frames
    .map((frame) => frame.trim().replace(/^at /, ""))
    .filter((frame) => frame.includes("/") && !frame.includes("/testing/hc-session.ts"));
  return callers.slice(0, 3).join(" < ") || "unknown";
}

/** A leftover session as the guard names it: its name and where it was made. */
const named = (scratch: Scratch): string => `${scratch.session.name} (made at ${scratch.made})`;

/** Every scratch session this process made, until `stopLeftoverCores` has checked it. */
const scratches = new Set<Scratch>();

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Whether a core answers on `socket`: a raw connect, since `hc connect` would start one that is not running. */
async function serving(socket: string): Promise<boolean> {
  try {
    const probe = await Bun.connect({ unix: socket, socket: { data: () => {} } });
    probe.end();
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ECONNREFUSED")) return false;
    throw error;
  }
}

/**
 * Stops the core of every scratch session that still serves, removes every scratch dir, and returns those sessions'
 * names. A core can outlive `dispose`: another core whose machine dials this session starts it again.
 *
 * With `only`, it checks just those sessions (a test's own) and leaves every other file's to that file's sweep or to
 * the preloaded guard at the end of the run, since one `bun test` process shares this registry across files (#261).
 */
export async function stopLeftoverCores(only?: Iterable<HcSession>): Promise<string[]> {
  return (await stopLeftover(only)).map((scratch) => scratch.session.name);
}

/** As stopLeftoverCores, each named with where its session was made, for the suite's guard. */
export async function stopLeftoverCoresNamed(): Promise<string[]> {
  return (await stopLeftover()).map(named);
}

async function stopLeftover(only?: Iterable<HcSession>): Promise<Scratch[]> {
  const wanted = only === undefined ? undefined : new Set(only);
  const checked = [...scratches].filter((scratch) => wanted === undefined || wanted.has(scratch.session));
  for (const scratch of checked) scratches.delete(scratch);
  const leftover = await Promise.all(
    checked.map(async (scratch) => {
      const alive = await serving(scratch.socket);
      if (alive) await stopCore(scratch.session);
      rmSync(scratch.dir, { recursive: true, force: true });
      return alive ? [scratch] : [];
    }),
  );
  return leftover.flat();
}

/**
 * Inside a test, checks the session once the test is over (after its afterEach): a session it disposed whose core
 * serves again fails that test, named with where the session was made, and the core is stopped; a core that comes back
 * later still reaches the suite's guard with the same name (#441). Outside a test (beforeAll, a script) nothing is set.
 */
function checkAtTestEnd(scratch: Scratch): void {
  try {
    onTestFinished(async () => {
      if (!scratch.disposed || !(await serving(scratch.socket))) return;
      scratches.delete(scratch);
      await stopCore(scratch.session);
      rmSync(scratch.dir, { recursive: true, force: true });
      throw new Error(`herdr-core outlived the test that started it (now stopped): ${named(scratch)}`);
    });
  } catch {
    // Not in a test: the suite's guard still checks this session at the end.
  }
}

/**
 * A scratch hc session: its own core, state dir and socket under $TMPDIR. `extra` joins the environment the core is
 * started with (a PATH that puts a test's `ssh` first, say).
 */
export function createHcSession(prefix: string, extra: Readonly<Record<string, string>> = {}): HcSession {
  const hc = resolveHcBin();
  const dir = mkdtempSync(join(tmpdir(), "dh-"));
  const name = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const socket = join(dir, "c.sock");
  const env = {
    ...process.env,
    HC_SESSION: name,
    XDG_STATE_HOME: join(dir, "state"),
    XDG_RUNTIME_DIR: join(dir, "run"),
    // A deep $TMPDIR (macOS) pushes the default socket path past the 103-byte sun_path limit.
    HC_SOCKET: socket,
    ...extra,
  };
  const session: HcSession = {
    hc,
    name,
    env,
    connect: () => {
      const proc = Bun.spawn([hc, "connect", "--session", name], {
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      });
      const reader = new ByteReader();
      const pump = async (source: ReadableStream<Uint8Array>): Promise<void> => {
        for await (const chunk of source) reader.push(chunk);
        reader.end();
      };
      void pump(proc.stdout);
      return {
        reader,
        exited: proc.exited,
        async write(bytes) {
          proc.stdin.write(bytes);
          await proc.stdin.flush();
        },
        end() {
          void proc.stdin.end();
        },
      };
    },
    dispose: async () => {
      scratch.disposed = true;
      // A core that never started has nothing to stop. Stopping it anyway would spawn hc connect, which starts a core
      // just to stop it, or fails a second time when hc itself is what kept it from starting (#1538).
      if (await serving(socket)) await stopCore(session);
      // A core started again after this one (a dialer reconnecting) makes the dir anew; the session stays registered,
      // so `stopLeftoverCores` still finds that core, stops it and removes the dir again.
      rmSync(dir, { recursive: true, force: true });
    },
  };
  const scratch: Scratch = { session, dir, socket, made: madeAt(), disposed: false };
  scratches.add(scratch);
  checkAtTestEnd(scratch);
  return session;
}
