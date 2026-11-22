import { watch } from "node:fs/promises";
import { DEVICES_FILE } from "../state/devices.ts";
import { MESH_FILE } from "../state/mesh-file.ts";

const AUTHORIZATION_FILES: ReadonlySet<string> = new Set([DEVICES_FILE, MESH_FILE]);

/**
 * Calls `closeRevoked` whenever devices.json or mesh.json changes, whoever wrote it (#2530), so a session that sends
 * nothing is still closed promptly after a revoke from another process. It is not the guard: every hc chunk is checked
 * against the stores as they are on disk ({@link LiveSessions.guardHc}), so a watch that cannot start, or an event the
 * platform drops, only delays an idle session's close until its next chunk. Returns the stop.
 */
export function watchRevocations(stateDir: string, closeRevoked: () => void, log: (line: string) => void): () => void {
  const stop = new AbortController();
  void (async () => {
    try {
      // An event without a name (some platforms) may be either file, so it counts as a change.
      for await (const { filename } of watch(stateDir, { signal: stop.signal, persistent: false })) {
        if (filename === null || AUTHORIZATION_FILES.has(filename)) closeRevoked();
      }
    } catch (error) {
      if (!stop.signal.aborted) {
        log(`revocation watch stopped, revokes from other processes close on a session's next chunk: ${String(error)}`);
      }
    }
  })();
  return () => stop.abort();
}
