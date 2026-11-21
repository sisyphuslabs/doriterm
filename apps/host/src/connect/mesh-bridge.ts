import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { isRecord } from "../state/files.ts";
import { CONNECTION_FAILED_EXIT, type SessionEnd, sessionExitCode } from "./exit-code.ts";
import type { Output } from "./pipe.ts";

export const LINE_SOCKET_NAME = "line.sock";

/** How often a bridge checks that the process that started it is still there. */
export const CALLER_CHECK_MS = 250;

export interface MeshBridgeOptions {
  readonly stateDir: string;
  readonly hostId: string;
  readonly input: AsyncIterable<Uint8Array>;
  readonly output: Output;
  readonly log: (line: string) => void;
}

type Answer = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function parseAnswer(line: string): Answer {
  const value: unknown = JSON.parse(line);
  if (isRecord(value) && value["ok"] === true) return { ok: true };
  const reason = isRecord(value) && typeof value["reason"] === "string" ? value["reason"] : "the host refused the line";
  return { ok: false, reason };
}

/** The process that started this bridge, watched so its bridge cannot outlive it. */
interface Caller {
  /** Resolves once this bridge's parent is gone (a stopped herdr core, a closed shell). */
  readonly gone: Promise<void>;
  stop(): void;
}

/**
 * A via child is herdr's, and a core that stops or is killed leaves it orphaned: the bridge then waits for a `line.sock`
 * answer that may never come, long after the core (and its test) are gone. The kernel reparents the child, so the
 * bridge sees it in `process.ppid` and gives up instead of becoming a leftover.
 */
function watchCaller(): Caller {
  const started = process.ppid;
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setInterval(() => {
    if (process.ppid === started) return;
    clearInterval(timer);
    resolve();
  }, CALLER_CHECK_MS);
  timer.unref();
  return { gone: promise, stop: () => clearInterval(timer) };
}

type Requested = { readonly socket: Socket; readonly answer: Answer; readonly rest: Buffer } | "gone";

/**
 * Connects to line.sock and reads the one-line answer; leftover bytes after it are the line's first bytes.
 * `callerGone` ends the request: a bridge whose caller is gone must not wait for an answer that may never come.
 */
function request(path: string, hostId: string, callerGone: Promise<void>): Promise<Requested> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      finish();
    };
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(0x0a);
      if (end === -1) return;
      socket.off("data", onData);
      socket.pause();
      try {
        const answer = parseAnswer(buffered.subarray(0, end).toString("utf8"));
        settle(() => resolve({ socket, answer, rest: buffered.subarray(end + 1) }));
      } catch (error) {
        settle(() => reject(error));
      }
    };
    socket.once("connect", () => socket.write(`${JSON.stringify({ v: 1, hostId })}\n`));
    socket.on("data", onData);
    socket.once("error", (error) => settle(() => reject(error)));
    socket.once("close", () => settle(() => reject(new Error("the host closed line.sock before answering"))));
    void callerGone.then(() =>
      settle(() => {
        socket.destroy();
        resolve("gone");
      }),
    );
  });
}

const notRunning = (error: unknown): boolean =>
  error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ECONNREFUSED");

/**
 * `doriface-host connect --mesh <hostId>` (section 7.2): asks the running host for a line to a member over
 * `<state dir>/line.sock`, then pipes stdin and stdout through it byte for byte. The host dials with its own Noise key;
 * this process holds no key. Every refusal is one line on stderr and exit 255 (exit-code.ts), as is a line that closed
 * before the member said a byte.
 *
 * The bridge lives exactly as long as its caller: the herdr core that spawned it, or the shell that ran it. When that
 * process is gone, so is the bridge, whether it was waiting for the answer or piping an open line.
 */
export async function meshBridge(options: MeshBridgeOptions): Promise<number> {
  const caller = watchCaller();
  try {
    let opened: Requested;
    try {
      opened = await request(join(options.stateDir, LINE_SOCKET_NAME), options.hostId, caller.gone);
    } catch (error) {
      options.log(notRunning(error) ? "doriface-host is not running" : `line.sock: ${String(error)}`);
      return CONNECTION_FAILED_EXIT;
    }
    if (opened === "gone") {
      options.log("the process that started this bridge is gone");
      return 1;
    }
    const { socket, answer, rest } = opened;
    if (!answer.ok) {
      options.log(answer.reason);
      socket.destroy();
      return CONNECTION_FAILED_EXIT;
    }
    const ended = Promise.withResolvers<number>();
    const end: { -readonly [K in keyof SessionEnd]: SessionEnd[K] } = {
      spoke: false,
      endedByCaller: false,
      error: undefined,
    };
    const deliver = (bytes: Uint8Array): boolean => {
      end.spoke = true;
      return options.output.write(bytes);
    };
    if (rest.byteLength > 0) deliver(rest);
    socket.on("data", (bytes: Buffer) => {
      if (!deliver(bytes)) {
        socket.pause();
        void options.output.drained().then(() => socket.resume());
      }
    });
    socket.once("close", () => {
      if (!end.spoke && !end.endedByCaller) options.log("the line closed before the member said anything");
      ended.resolve(sessionExitCode(end));
    });
    socket.once("error", (error) => {
      options.log(`the line ended: ${error.message}`);
      end.error = error;
      ended.resolve(sessionExitCode(end));
    });
    socket.resume();
    void (async () => {
      for await (const chunk of options.input)
        if (!socket.write(chunk)) await new Promise((r) => socket.once("drain", r));
      end.endedByCaller = true;
      socket.end();
    })();
    const code = await Promise.race([
      ended.promise,
      caller.gone.then(() => {
        socket.destroy();
        return 1;
      }),
    ]);
    await options.output.drained();
    return code;
  } finally {
    caller.stop();
  }
}
