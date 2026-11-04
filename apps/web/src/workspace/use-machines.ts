import type { HcConnection } from "@doriface/client";
import type { MachineView, Terminal } from "@doriface/protocol";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { machineEntries, machineKey, orderMachines, type MachineEntry } from "./machines.ts";
import type { Session } from "./model.ts";
import { withReach } from "./reach.ts";

export interface Machines {
  readonly entries: readonly MachineEntry[];
  /** Starts a shell on that machine (`terminal.run` with `on`) and opens it at its `machine/tN` address. */
  readonly newTerminalOn: (machine: string) => void;
  /** Why the last machine.list failed, until one succeeds. */
  readonly listError: string | undefined;
  /** Shows how to add a machine (the pairing commands). */
  readonly openAddMachine: () => void;
  /** The added machines as machine.list last said: state, `why`, since when. */
  readonly views: readonly MachineView[];
  /** Dials a machine now (`machine.connect`) instead of at hc's next retry, then reads machine.list again. */
  readonly retry: (machine: string) => Promise<void>;
  /** Moves a machine (by its permanent core id) to index `to` of `entries` and saves the order for every device. */
  readonly moveMachine: (core: string, to: number) => void;
}

export const MachinesContext = createContext<Machines>({
  entries: [],
  newTerminalOn: () => {},
  listError: undefined,
  openAddMachine: () => {},
  views: [],
  retry: async () => {},
  moveMachine: () => {},
});

export const useMachinesContext = (): Machines => useContext(MachinesContext);

/**
 * hc sends no event when a machine's line comes up, drops or wants a login, so machine.list is also read on a timer
 * while the page is visible. hc redials within 250 ms to 30 s and one machine.list is a few hundred bytes, so every
 * 10 s keeps a stale state shorter than it takes to notice and click, for at most 6 small calls a minute.
 */
export const MACHINE_REFRESH_MS = 10_000;

export interface MachineState {
  readonly entries: readonly MachineEntry[];
  /** The terminals with those on a machine that is not connected marked unreachable (`withReach`). */
  readonly terminals: readonly Session[];
  /** Reads machine.list again now, e.g. after a call on a machine failed. */
  readonly refresh: () => void;
  readonly listError: string | undefined;
  readonly views: readonly MachineView[];
  readonly retry: (machine: string) => Promise<void>;
  /** How many machine.list reads have come back: a tab waits one read before taking a gone terminal as removed. */
  readonly listed: number;
}

/** machine.list, read again when a machine's live terminals change, on a timer while visible, and on return. */
export function useMachines(connection: HcConnection, terminals: readonly Terminal[]): MachineState {
  const [views, setViews] = useState<readonly MachineView[]>([]);
  const [reads, setReads] = useState(0);
  const [listError, setListError] = useState<string | undefined>(undefined);
  const [listed, setListed] = useState(0);
  const refresh = useCallback(() => setReads((count) => count + 1), []);
  const key = machineKey(terminals);
  useEffect(() => {
    let current = true;
    connection.call("machine.list").then(
      (list) => {
        if (!current) return list;
        setViews(orderMachines(list.machines));
        setListError(undefined);
        setListed((count) => count + 1);
        return list;
      },
      (error: unknown) => {
        if (current) setListError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      current = false;
    };
  }, [connection, key, reads]);
  useEffect(() => {
    const whenVisible = (): void => {
      if (document.visibilityState === "visible") refresh();
    };
    const timer = setInterval(whenVisible, MACHINE_REFRESH_MS);
    document.addEventListener("visibilitychange", whenVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", whenVisible);
    };
  }, [refresh]);
  const { id: coreId, name: coreName } = connection.hello.core;
  const reached = useMemo(() => withReach(terminals, views), [terminals, views]);
  const entries = useMemo(
    () => machineEntries({ id: coreId, name: coreName }, views, reached),
    [coreId, coreName, views, reached],
  );
  // A refused dial is not lost: hc records it as the machine's `why`, which the re-read brings in.
  const retry = useCallback(
    (machine: string) => connection.call("machine.connect", { machine }).then(refresh, refresh),
    [connection, refresh],
  );
  return { entries, terminals: reached, refresh, listError, views, retry, listed };
}
