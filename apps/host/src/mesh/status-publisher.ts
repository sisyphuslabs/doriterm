import type { MeshStatus } from "@doriface/protocol";
import { type HcTarget, type KillableLink, openOnCore, spawnHcLink } from "./hc-machines.ts";
import { docStoreOf, publishMeshStatus } from "./status-doc.ts";

/**
 * The panel in Settings reads the document every 10 s (`MACHINE_REFRESH_MS`), so a tick at that cadence keeps what a
 * client reads at most one tick behind what `mesh status` would answer. Each tick runs on an `hc connect` child of its
 * own, as the git facts' ticks do: a core that stops answering cannot hold the publisher behind one hung child.
 */
const TICK_MS = 10_000;

export interface MeshStatusPublisher {
  /** One publish: writes this host's status (or clears the document), then exits its child. The timer calls it. */
  tick(): Promise<void>;
  /** Settles once the ticks asked for so far are over and their children have exited. */
  settled(): Promise<void>;
  /** Ends the timer and the tick in flight; settles once its child has exited. */
  stop(): Promise<void>;
  /** Kills the tick in flight's child if it has not exited, and returns the pids it killed. */
  kill(): readonly number[];
}

/**
 * Keeps this host's mesh status on its own core, in the `doriface-mesh` document a client reads (contract 1.5, design
 * sections 8.6). `current` is the function `mesh status` answers from, so the document and the command cannot disagree,
 * and `self` is this host's own hostId, which decides whether a document left behind is its to clear.
 */
export function publishMeshStatusOnCore(
  core: HcTarget,
  current: () => MeshStatus | undefined,
  self: string,
  log: (line: string) => void,
  link: (core: HcTarget) => KillableLink = spawnHcLink,
  tickMs: number = TICK_MS,
  /** Runs before each publish: the host reads herdr's machine list again, so the document names lines as herdr does. */
  refresh: () => Promise<void> = () => Promise.resolve(),
): MeshStatusPublisher {
  let stopped = false;
  let child: KillableLink | undefined;
  let childOpen = false;
  let exited: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastError: string | undefined;
  let running: Promise<void> = Promise.resolve();

  const runTick = async (): Promise<void> => {
    if (stopped) return;
    try {
      // Inside the try: a spawn that fails (hc gone, its directory removed) is logged like any other failed tick.
      const opened = link(core);
      child = opened;
      childOpen = true;
      exited = new Promise<void>((resolve) =>
        opened.onClose(() => {
          childOpen = false;
          resolve();
        }),
      );
      try {
        const connection = await openOnCore(opened, core);
        try {
          await refresh();
          await publishMeshStatus(docStoreOf(connection), current, self);
          lastError = undefined;
        } finally {
          connection.close();
        }
      } finally {
        opened.close();
        await exited;
      }
    } catch (error) {
      const line = `host: cannot write this host's mesh status on its core: ${String(error)}`;
      if (!stopped && line !== lastError) log(line);
      lastError = line;
    }
  };

  // One tick at a time: a timer that fires while a tick runs waits for it, so publishes cannot overtake each other.
  const tick = (): Promise<void> => {
    running = running.then(runTick, runTick);
    return running;
  };
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick().finally(schedule);
    }, tickMs);
  };
  void tick().finally(schedule);

  return {
    tick,
    settled: () => running,
    stop() {
      stopped = true;
      clearTimeout(timer);
      child?.close();
      return exited;
    },
    kill() {
      if (child?.kill === undefined || child.pid === undefined || !childOpen) return [];
      child.kill("SIGKILL");
      return [child.pid];
    },
  };
}
