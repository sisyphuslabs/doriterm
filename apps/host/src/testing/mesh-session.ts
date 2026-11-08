import { realpathSync, type Stats, unwatchFile, watchFile } from "node:fs";
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
 * Run the fixture's core directly: hc connect would auto-start it through launchd on macOS, outside the fixture's
 * process tree and filesystem access. Its machine bridges share this owned group, including their descendants.
 */
export async function ownMeshSession(session: HcSession): Promise<HcSession> {
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
    stderr: "inherit",
  });
  adoptProcessGroup(core, dir);
  void core.exited.then((code) => ready.reject(new Error(`mesh core exited before readiness: ${code}`)));
  const deadline = setTimeout(() => ready.reject(new Error("mesh core did not create its socket")), 15_000);
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
