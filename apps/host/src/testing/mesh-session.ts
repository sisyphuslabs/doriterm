import { lstatSync, realpathSync, type Stats, unwatchFile, watchFile } from "node:fs";
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
  // Directory fs.watch does not reliably report Unix socket creation on macOS.
  const onSocket = (stat: Stats): void => {
    if (stat.isSocket()) ready.resolve();
  };
  watchFile(socket, { interval: 50 }, onSocket);
  const core = Bun.spawn([session.hc, "serve"], {
    // hc 0.1.17 scopes its direct-start opt-in to the immediate parent's pid.
    env: { ...session.env, HC_LAUNCHD_DIRECT: String(process.pid) },
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  adoptProcessGroup(core, dir);
  // The core's stderr still reaches the run's log as it comes, and its tail is kept for a failure to quote (#1768).
  const stderr = teeTail(core.stderr);
  // The exit is reported once the core's stderr has been read to its end, so its last words are in the message. A
  // descendant that keeps the pipe open holds this back; the deadline below then names the exit instead.
  void Promise.all([core.exited, stderr.drained]).then(([code]) =>
    ready.reject(new Error(`mesh core exited before readiness: ${code}; stderr: ${stderr.tail() || "(none)"}`)),
  );
  const deadline = setTimeout(() => {
    const state =
      core.exitCode === null && core.signalCode === null
        ? "was still running"
        : `had exited (${core.exitCode ?? core.signalCode})`;
    const path = socketPathState(socket);
    ready.reject(
      new Error(
        `mesh core did not create its socket within ${readyWithinMs} ms: hc serve (pid ${core.pid}) ${state}; ${path}; stderr: ${stderr.tail() || "(none)"}`,
      ),
    );
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
  } catch (error) {
    await stop(false);
    throw error;
  } finally {
    clearTimeout(deadline);
    unwatchFile(socket, onSocket);
  }
  return { ...session, dispose: () => (stopping ??= stop(true)) };
}
