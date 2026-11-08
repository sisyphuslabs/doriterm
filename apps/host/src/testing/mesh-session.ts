import { type Stats, unwatchFile, watchFile } from "node:fs";
import { dirname } from "node:path";
import { stopLeftoverCores, type HcSession } from "./hc-session.ts";
import { adoptProcessGroup, stopProcessGroup } from "./process-group.ts";

/**
 * Run the fixture's core directly: hc connect would auto-start it through launchd on macOS, outside the fixture's
 * process tree and filesystem access. Its machine bridges share this owned group, including their descendants.
 */
export async function ownMeshSession(session: HcSession): Promise<HcSession> {
  const socket = session.env["HC_SOCKET"];
  if (socket === undefined) throw new Error("mesh session has no socket");
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
  adoptProcessGroup(core, dirname(socket));
  void core.exited.then((code) => ready.reject(new Error(`mesh core exited before readiness: ${code}`)));
  const deadline = setTimeout(() => ready.reject(new Error("mesh core did not create its socket")), 15_000);
  let stopping: Promise<void> | undefined;
  const stop = async (): Promise<void> => {
    try {
      await stopProcessGroup(core);
    } finally {
      await stopLeftoverCores([session]);
    }
  };
  try {
    await ready.promise;
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(deadline);
    unwatchFile(socket, onSocket);
  }
  return { ...session, dispose: () => (stopping ??= stop()) };
}
