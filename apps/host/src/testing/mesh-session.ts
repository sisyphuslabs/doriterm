import { lstatSync, readFileSync, realpathSync, type Stats, unwatchFile, watchFile } from "node:fs";
import { dirname, join } from "node:path";
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

const READY_MS = 15_000;
const PROBE_MS = 50;
const TAIL_BYTES = 2_048;

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** The last TAIL_BYTES of a core's output file, or why it could not be read. */
function tailOf(path: string): string {
  try {
    const text = readFileSync(path, "utf8");
    if (text === "") return "(empty)";
    return text.length > TAIL_BYTES ? `...${text.slice(-TAIL_BYTES)}` : text;
  } catch (error) {
    return `(unreadable: ${String(error)})`;
  }
}

/**
 * What happened to a core between its spawn and the fixture's readiness verdict, on the monotonic clock in ms after the
 * spawn (#1547). `probe` is the fixture's own check, independent of the watchFile callback that decides readiness: it
 * lstats the socket path and connects to it every PROBE_MS, so a socket the callback missed still shows here.
 */
interface Startup {
  readonly spawned: number;
  /** When the independent probe first saw a socket at the path. */
  socketSeen?: number;
  /** When the independent probe first connected. */
  connected?: number;
  /** When the watchFile callback saw the socket: readiness. */
  watched?: number;
  /** How many times the watchFile callback ran, socket or not. */
  watchCalls: number;
  exited?: { readonly at: number; readonly code: number | null; readonly signal: string | number | null };
}

function describe(startup: Startup, now: number, out: string, err: string): string {
  const at = (time: number | undefined): string =>
    time === undefined ? "never" : `+${(time - startup.spawned).toFixed(0)} ms`;
  const exited =
    startup.exited === undefined
      ? "still running"
      : `${at(startup.exited.at)} (code ${startup.exited.code}, signal ${startup.exited.signal})`;
  return [
    `  verdict at ${at(now)}; times are monotonic, after the core's spawn`,
    `  socket first seen by the independent probe: ${at(startup.socketSeen)}`,
    `  first connection by the independent probe: ${at(startup.connected)}`,
    `  watchFile callback saw the socket: ${at(startup.watched)} (${startup.watchCalls} callbacks in all)`,
    `  core exited: ${exited}`,
    `  core stdout tail: ${out}`,
    `  core stderr tail: ${err}`,
  ].join("\n");
}

/** Records the first lstat that shows a socket at `socket` and the first connect to it, until `done` is set. */
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
export async function ownMeshSession(session: HcSession): Promise<HcSession> {
  const socket = session.env["HC_SOCKET"];
  if (socket === undefined) throw new Error("mesh session has no socket");
  // Resolved, since a process is seen holding resolved paths (macOS: /var is a link into /private).
  const dir = realpathSync(dirname(socket));
  const ready = Promise.withResolvers<void>();
  // Files, not pipes: a pipe would need draining for the core's whole life, and the holders it starts inherit it.
  const outPath = join(dir, "core.out");
  const errPath = join(dir, "core.err");
  let startup: Startup | undefined;
  // Directory fs.watch does not reliably report Unix socket creation on macOS.
  const onSocket = (stat: Stats): void => {
    if (startup !== undefined) {
      startup.watchCalls += 1;
      if (stat.isSocket()) startup.watched ??= performance.now();
    }
    if (stat.isSocket()) ready.resolve();
  };
  watchFile(socket, { interval: 50 }, onSocket);
  const core = Bun.spawn([session.hc, "serve"], {
    // hc 0.1.17 scopes its direct-start opt-in to the immediate parent's pid.
    env: { ...session.env, HC_LAUNCHD_DIRECT: String(process.pid) },
    detached: true,
    stdin: "ignore",
    stdout: Bun.file(outPath),
    stderr: Bun.file(errPath),
  });
  const started: Startup = { spawned: performance.now(), watchCalls: 0 };
  startup = started;
  adoptProcessGroup(core, dir);
  let settled = false;
  const report = (message: string): Error =>
    new Error(`${message}\n${describe(started, performance.now(), tailOf(outPath), tailOf(errPath))}`);
  void probe(socket, started, () => settled).catch((error: unknown) => ready.reject(error));
  const onExit = (code: number): void => {
    started.exited = { at: performance.now(), code, signal: core.signalCode };
    if (!settled) ready.reject(report(`mesh core exited before readiness: ${code}`));
  };
  void core.exited.then(onExit);
  const deadline = setTimeout(
    () => ready.reject(report(`mesh core did not create its socket within ${READY_MS} ms`)),
    READY_MS,
  );
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
      console.error(`mesh core ready (${session.name})\n${describe(started, performance.now(), "-", "-")}`);
    }
  } catch (error) {
    await stop(false);
    throw error;
  } finally {
    settled = true;
    clearTimeout(deadline);
    unwatchFile(socket, onSocket);
  }
  return { ...session, dispose: () => (stopping ??= stop(true)) };
}
