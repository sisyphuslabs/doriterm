import type { HcConnection } from "@doriface/client";
import { HcRpcError, HOST_INFO_DOC, type HostInfo, hostInfoFor, parseHostInfo } from "@doriface/protocol";
import { type HcTarget, type KillableLink, openOnCore, spawnHcLink } from "./mesh/hc-machines.ts";

export interface HostInfoPublisher {
  /** Settles once the document is written (or left as it was, or the write failed and was logged) and its child exited. */
  readonly settled: Promise<void>;
  /** Ends the write if it is still going; settles once its `hc connect` child has exited. */
  stop(): Promise<void>;
  /** Kills the write's child if it has not exited (one that ignores a closed stdin), and returns the pids it killed. */
  kill(): readonly number[];
}

const isConflict = (error: unknown): boolean => error instanceof HcRpcError && error.kind === "conflict";

/**
 * Writes this host's `doriface-host` document on its own core over one `hc connect` child of its own, so a client
 * reads the host's OS from the core (for this machine, or `on` a machine the core added) instead of guessing it. hc's
 * frames pass through untouched. A host on an OS the document does not name writes nothing, so clients keep guessing.
 */
export function publishHostInfo(
  core: HcTarget,
  platform: string,
  log: (line: string) => void,
  link: (core: HcTarget) => KillableLink = spawnHcLink,
): HostInfoPublisher {
  const info = hostInfoFor(platform);
  if (info === undefined) return { settled: Promise.resolve(), stop: () => Promise.resolve(), kill: () => [] };
  let stopped = false;
  // A hello the core never answers would hold `stop` for the handshake deadline; stopping ends it instead.
  const stopping = new AbortController();
  const child = link(core);
  let childOpen = true;
  const exited = new Promise<void>((resolve) =>
    child.onClose(() => {
      childOpen = false;
      resolve();
    }),
  );
  const write = async (): Promise<void> => {
    const connection = await openOnCore(child, core, { signal: stopping.signal });
    try {
      await writeHostInfo(connection, info);
    } finally {
      connection.close();
    }
  };
  const settled = write()
    .catch((error: unknown) => {
      if (!stopped) log(`host: cannot write this host's OS on its core: ${String(error)}`);
    })
    .finally(() => child.close())
    .then(() => exited);
  return {
    settled,
    stop() {
      stopped = true;
      stopping.abort(new Error("the host is stopping"));
      child.close();
      return exited;
    },
    kill() {
      if (child.kill === undefined || child.pid === undefined || !childOpen) return [];
      child.kill("SIGKILL");
      return [child.pid];
    },
  };
}

/** Writes `info` unless the core holds it already; a `conflict` (another writer moved the document) is read and written once more. */
export function writeHostInfo(
  connection: Pick<HcConnection, "call">,
  info: HostInfo,
): Promise<"written" | "unchanged"> {
  return writeOnce(connection, info).catch((error: unknown) =>
    isConflict(error) ? writeOnce(connection, info) : Promise.reject(error),
  );
}

async function writeOnce(connection: Pick<HcConnection, "call">, info: HostInfo): Promise<"written" | "unchanged"> {
  const current = await connection.call("doc.get", { name: HOST_INFO_DOC });
  if (parseHostInfo(current.value)?.os === info.os) return "unchanged";
  await connection.call("doc.set", { name: HOST_INFO_DOC, value: { ...info }, version: current.version });
  return "written";
}
