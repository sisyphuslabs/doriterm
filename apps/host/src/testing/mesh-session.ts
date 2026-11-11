import { lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { stopLeftoverCores, type HcSession } from "./hc-session.ts";
import { adoptProcessGroup, stopProcessGroup } from "./process-group.ts";
import { stopRunProcesses } from "./run-cores.ts";

/**
 * Stops every hc process still holding a file under the session's `dir`, with its descendants, and fails naming them.
 * They are out of the core group's reach: hc starts a terminal's holder, and the core a holder starts again, in a
 * session of their own (setsid), and the holder's programs in sessions of theirs. A clean stop leaves none.
 */
async function stopEscaped(dir: string): Promise<void> {
  // No process carries this mark, so the scan finds the session's processes by the files they hold under `dir` alone.
  const escaped = await stopRunProcesses({ mark: crypto.randomUUID(), dir });
  if (escaped.length === 0) return;
  const named = escaped.map(({ pid, command, where }) => `pid ${pid}: ${command} (${where})`);
  throw new Error(
    `${escaped.length} hc processes outlived the mesh session's stop (now stopped):\n  ${named.join("\n  ")}`,
  );
}

/**
 * Copies a stream to this process's stderr as it arrives and keeps its last `keep` characters; `drained` settles once the
 * stream has ended and every chunk is in the tail.
 */
function teeTail(
  stream: ReadableStream<Uint8Array>,
  keep = 4096,
): { readonly tail: () => string; readonly drained: Promise<void> } {
  let tail = "";
  const decoder = new TextDecoder();
  const drained = (async () => {
    for await (const chunk of stream) {
      process.stderr.write(chunk);
      tail = (tail + decoder.decode(chunk, { stream: true })).slice(-keep);
    }
  })().catch(() => undefined);
  return { tail: () => tail.trim(), drained };
}

/** What is at the socket path when the deadline passes. */
function socketPathState(socket: string): string {
  try {
    return lstatSync(socket).isSocket()
      ? "socket created only as the deadline passed"
      : "socket path exists but is not a socket";
  } catch {
    return "socket path absent";
  }
}

const PROBE_MS = 50;

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** What happened to a core between its spawn and the fixture's readiness verdict, on the monotonic clock (#1547). */
interface Startup {
  readonly spawned: number;
  /** When the probe first saw a socket at the path. */
  socketSeen?: number;
  /** When the probe first connected: readiness. */
  connected?: number;
  exited?: { readonly at: number; readonly code: number | null; readonly signal: string | number | null };
}

function describe(startup: Startup, now: number, stderrTail: string): string {
  const at = (time: number | undefined): string =>
    time === undefined ? "never" : `+${(time - startup.spawned).toFixed(0)} ms`;
  const exited =
    startup.exited === undefined
      ? "still running"
      : `${at(startup.exited.at)} (code ${startup.exited.code}, signal ${startup.exited.signal})`;
  return [
    `  verdict at ${at(now)}; times are monotonic, after the core's spawn`,
    `  socket first seen: ${at(startup.socketSeen)}`,
    `  first connection: ${at(startup.connected)}`,
    `  core exited: ${exited}`,
    `  core stderr tail: ${stderrTail}`,
  ].join("\n");
}

/**
 * Records the first lstat that shows a socket at `socket` and the first connect to it, until `done` is set. A core is
 * ready once it accepts a connection. Not watchFile: Bun's stat scheduler can leave a watcher added while its pass is
 * in flight never polled again, which under load left cores serving within a second unseen for the whole budget.
 */
async function probe(socket: string, startup: Startup, done: () => boolean): Promise<void> {
  if (!done() && startup.connected === undefined) {
    if (startup.socketSeen === undefined) {
      try {
        if (lstatSync(socket).isSocket()) startup.socketSeen = performance.now();
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
    }
    if (startup.socketSeen !== undefined) {
      try {
        const connection = await Bun.connect({ unix: socket, socket: { data: () => {} } });
        startup.connected = performance.now();
        connection.end();
      } catch (error) {
        if (!isErrno(error, "ENOENT") && !isErrno(error, "ECONNREFUSED")) throw error;
      }
    }
  }
  if (done() || startup.connected !== undefined) return;
  // No event reports a socket appearing at a path on both Linux and macOS, so the probe looks again.
  await Bun.sleep(PROBE_MS);
  return probe(socket, startup, done);
}

/**
 * Run the fixture's core directly: hc connect would auto-start it through launchd on macOS, outside the fixture's
 * process tree and filesystem access. Its machine bridges share this owned group, including their descendants.
 */
export async function ownMeshSession(
  session: HcSession,
  { readyWithinMs = 15_000 }: { readonly readyWithinMs?: number } = {},
): Promise<HcSession> {
  const socket = session.env["HC_SOCKET"];
  if (socket === undefined) throw new Error("mesh session has no socket");
  // Resolved, since a process is seen holding resolved paths (macOS: /var is a link into /private).
  const dir = realpathSync(dirname(socket));
  const ready = Promise.withResolvers<void>();
  const core = Bun.spawn([session.hc, "serve"], {
    // hc 0.1.17 scopes its direct-start opt-in to the immediate parent's pid.
    env: { ...session.env, HC_LAUNCHD_DIRECT: String(process.pid) },
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const started: Startup = { spawned: performance.now() };
  adoptProcessGroup(core, dir);
  // The core's stderr still reaches the run's log as it comes, and its tail is kept for a failure to quote (#1768).
  const stderr = teeTail(core.stderr);
  let settled = false;
  const report = (message: string, cause?: unknown): Error =>
    new Error(
      `${message}\n${describe(started, performance.now(), stderr.tail() || "(none)")}`,
      cause === undefined ? undefined : { cause },
    );
  void probe(socket, started, () => settled).then(
    () => ready.resolve(),
    (error: unknown) => ready.reject(report(`mesh core readiness probe failed: ${String(error)}`, error)),
  );
  void core.exited.then((code) => (started.exited = { at: performance.now(), code, signal: core.signalCode }));
  // The exit is reported once the core's stderr has been read to its end, so its last words are in the message. A
  // descendant that keeps the pipe open holds this back; the deadline below then names the exit instead.
  void Promise.all([core.exited, stderr.drained]).then(([code]) =>
    settled ? undefined : ready.reject(report(`mesh core exited before readiness: ${code}`)),
  );
  const deadline = setTimeout(() => {
    const state =
      core.exitCode === null && core.signalCode === null
        ? "was still running"
        : `had exited (${core.exitCode ?? core.signalCode})`;
    // The path's state only adds news while the probe never saw a socket: once it did, the timeline says when (#1724 review).
    const headline =
      started.socketSeen === undefined
        ? `mesh core did not create its socket within ${readyWithinMs} ms: hc serve (pid ${core.pid}) ${state}; ${socketPathState(socket)}`
        : `mesh core created its socket but accepted no connection within ${readyWithinMs} ms: hc serve (pid ${core.pid}) ${state}`;
    // The stderr tail is in the timeline report() appends, once.
    ready.reject(report(headline));
  }, readyWithinMs);
  let stopping: Promise<void> | undefined;
  const stop = async (shutdown: boolean): Promise<void> => {
    try {
      // hc takes SIGTERM for a planned restart: the core hands its terminals to their holder, which starts a new core.
      // server.stop ends the holder and the programs it holds, so it goes before the group's signal.
      if (shutdown) await session.dispose();
    } finally {
      try {
        await stopProcessGroup(core);
      } finally {
        try {
          await stopLeftoverCores([session]);
        } finally {
          await stopEscaped(dir);
        }
      }
    }
  };
  try {
    await ready.promise;
    if (process.env["MESH_STARTUP_TRACE"] === "1") {
      console.error(`mesh core ready (${session.name})\n${describe(started, performance.now(), "-")}`);
    }
  } catch (error) {
    await stop(false);
    throw error;
  } finally {
    settled = true;
    clearTimeout(deadline);
  }
  return { ...session, dispose: () => (stopping ??= stop(true)) };
}
