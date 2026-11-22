import type { HcConnection } from "@doriface/client";
import {
  HcRpcError,
  HOST_INFO_DOC,
  type HostInfo,
  hostInfoFor,
  type JsonValue,
  type SkillStatus,
} from "@doriface/protocol";
import { type HcTarget, type KillableLink, openOnCore, spawnHcLink } from "./mesh/hc-machines.ts";

export interface HostInfoPublisher {
  /** Settles once the latest write is done (or left as it was, or failed and was logged) and its child exited. */
  readonly settled: Promise<void>;
  /** Writes the document again, after the write in flight: the skill status changed. */
  refresh(): void;
  /** Ends the write if it is still going; settles once its `hc connect` child has exited. */
  stop(): Promise<void>;
  /** Kills the write's child if it has not exited (one that ignores a closed stdin), and returns the pids it killed. */
  kill(): readonly number[];
}

type OneWrite = Omit<HostInfoPublisher, "refresh">;

const isConflict = (error: unknown): boolean => error instanceof HcRpcError && error.kind === "conflict";

/** One write of the document over one `hc connect` child of its own, which exits once the write is done. */
function writeOnCore(
  core: HcTarget,
  info: HostInfo,
  skill: (() => Promise<SkillStatus>) | undefined,
  log: (line: string) => void,
  link: (core: HcTarget) => KillableLink,
): OneWrite {
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
    const [connection, status] = await Promise.all([openOnCore(child, core, { signal: stopping.signal }), skill?.()]);
    try {
      await writeHostInfo(connection, status === undefined ? info : { ...info, skill: status });
    } finally {
      connection.close();
    }
  };
  const settled = write()
    .catch((error: unknown) => {
      if (!stopped) log(`host: cannot write this host's facts on its core: ${String(error)}`);
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

/**
 * Writes this host's `doriface-host` document on its own core, so a client reads the host's OS (and where the agent
 * skill stands, when `skill` is given) from the core, for this machine or `on` a machine the core added, instead of
 * guessing it. Each write runs over a child of its own that exits once it is done; `refresh` writes again. hc's frames
 * pass through untouched. A host on an OS the document does not name writes nothing, so clients keep guessing.
 */
export function publishHostInfo(
  core: HcTarget,
  platform: string,
  log: (line: string) => void,
  link: (core: HcTarget) => KillableLink = spawnHcLink,
  skill?: () => Promise<SkillStatus>,
): HostInfoPublisher {
  const info = hostInfoFor(platform);
  let stopped = false;
  // The first write starts at once, so a `stop` right away finds its child to close.
  let current = info === undefined ? undefined : writeOnCore(core, info, skill, log, link);
  let chain = current?.settled ?? Promise.resolve();
  const refresh = (): void => {
    if (info === undefined || stopped) return;
    chain = chain.then(() => {
      if (stopped) return undefined;
      current = writeOnCore(core, info, skill, log, link);
      return current.settled;
    });
  };
  return {
    get settled() {
      return chain;
    },
    refresh,
    stop() {
      stopped = true;
      return Promise.resolve(current?.stop()).then(() => chain);
    },
    kill() {
      return current?.kill() ?? [];
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
  const value: JsonValue = { ...info };
  if (Bun.deepEquals(current.value, value)) return "unchanged";
  await connection.call("doc.set", { name: HOST_INFO_DOC, value, version: current.version });
  return "written";
}
