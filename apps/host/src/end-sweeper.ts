import { HcConnection } from "@doriface/client";
import { END_LABEL, eventAddress, type HcEvent, HcRpcError, type Terminal } from "@doriface/protocol";
import { handshakeOf, type HcTarget, type KillableLink, spawnHcLink } from "./mesh/hc-machines.ts";

export interface EndSweeper {
  /**
   * Watches the core unless a watch is open already, and settles once that watch has read the core. Called as a client
   * connects, so a watch whose connection closed (the core restarted) is opened again.
   */
  ensure(): Promise<void>;
  stop(): Promise<void>;
  /** Kills the watch's child if it has not exited (one that ignores a closed stdin), and returns the pids it killed. */
  kill(): readonly number[];
}

/** hc's reason for a program that `terminal.kill` ended, as End's kill does; a program that exits by itself is "exited". */
const KILLED = "killed";

/**
 * Removes every terminal whose program was killed and that carries END_LABEL: an End that marked and killed a terminal
 * finishes on the core even when the page that asked closed before its own terminal.rm went out. A marked program that
 * exits by itself is left alone: its End did not happen (the kill never landed), so its output stays. Watches over one
 * connection of its own, through `link` (an `hc connect` child).
 */
export function endSweeper(
  core: HcTarget,
  log: (line: string) => void,
  link: (core: HcTarget) => KillableLink = spawnHcLink,
): EndSweeper {
  let watching: Promise<HcConnection | undefined> | undefined;
  let open: HcConnection | undefined;
  /** Settles once the latest `hc connect` child has exited, so `stop` leaves no child behind. */
  let exited: Promise<void> = Promise.resolve();
  let child: KillableLink | undefined;
  let childOpen = false;
  let stopped = false;
  // A hello the core never answers would hold `stop` for the handshake deadline; stopping ends it instead.
  const stopping = new AbortController();
  const watch = async (): Promise<HcConnection> => {
    const next = link(core);
    const gone = Promise.withResolvers<void>();
    next.onClose(() => {
      if (child === next) childOpen = false;
      gone.resolve();
    });
    child = next;
    childOpen = true;
    exited = gone.promise;
    let connection: HcConnection;
    try {
      connection = await HcConnection.open(next, { ...handshakeOf(core), signal: stopping.signal });
    } catch (error) {
      next.close();
      throw error;
    }
    try {
      await follow(connection);
    } catch (error) {
      connection.close();
      throw error;
    }
    return connection;
  };
  const follow = async (connection: HcConnection): Promise<void> => {
    const killed = new Set<string>();
    const marked = new Set<string>();
    const sweep = (address: string): void => {
      if (!killed.has(address) || !marked.has(address)) return;
      killed.delete(address);
      connection.call("terminal.rm", { terminal: address }).catch((error: unknown) => {
        // not_found: the page's own End or another client got there first.
        if (!(error instanceof HcRpcError && error.kind === "not_found"))
          log(`end: removing ${address}: ${String(error)}`);
      });
    };
    const learn = (terminal: Terminal): void => {
      if (terminal.state === "finished" && terminal.reason === KILLED) killed.add(terminal.address);
      if (Object.hasOwn(terminal.labels ?? {}, END_LABEL)) marked.add(terminal.address);
      sweep(terminal.address);
    };
    const apply = (event: HcEvent): void => {
      const address = eventAddress(event);
      if (address === undefined) return;
      switch (event.type) {
        case "created":
        case "restarted":
          killed.delete(address);
          break;
        case "removed":
          killed.delete(address);
          marked.delete(address);
          break;
        case "finished":
          if (event.data.reason === KILLED) killed.add(address);
          sweep(address);
          break;
        case "labels":
          if (Object.hasOwn(event.data.labels, END_LABEL)) marked.add(address);
          else marked.delete(address);
          sweep(address);
          break;
        default:
          break;
      }
    };
    // Events first, then every terminal finished ones included: a terminal that finishes in between is in one or both.
    const feed = await connection.subscribe();
    feed.onEvent(apply);
    const listAll = async (): Promise<void> => {
      for (const terminal of (await connection.call("terminal.list", { all: true })).terminals) learn(terminal);
    };
    feed.onSnapshot(() => void listAll().catch((error: unknown) => log(`end: listing terminals: ${String(error)}`)));
    await listAll();
  };
  return {
    ensure: () => {
      if (stopped) return Promise.resolve();
      if (watching === undefined || open?.closed === true) {
        open = undefined;
        const started: Promise<HcConnection | undefined> = watch().then(
          (connection) => {
            open = connection;
            return connection;
          },
          (error: unknown) => {
            if (!stopped) log(`end: not watching the core: ${String(error)}`);
            if (watching === started) watching = undefined;
            return undefined;
          },
        );
        watching = started;
      }
      return watching.then(() => undefined);
    },
    stop: async () => {
      stopped = true;
      stopping.abort(new Error("the host is stopping"));
      (await watching)?.close();
      await exited;
    },
    kill: () => {
      if (child?.kill === undefined || child.pid === undefined || !childOpen) return [];
      child.kill("SIGKILL");
      return [child.pid];
    },
  };
}
