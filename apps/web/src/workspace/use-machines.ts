import type { HcConnection } from "@doriface/client";
import type { MachineView, Terminal, TerminalRunParams } from "@doriface/protocol";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { MACHINE_REFRESH_MS } from "../roster/roster.ts";
import { useRoster } from "../roster/use-roster.ts";
import { graceEnds, graceViews } from "./machine-grace.ts";
import { machineEntries, type MachineEntry } from "./machines.ts";
import type { Session } from "./model.ts";
import { withReach } from "./reach.ts";
import { useSteady } from "./steady.ts";

export { MACHINE_REFRESH_MS };

export interface Machines {
  readonly entries: readonly MachineEntry[];
  /** The first terminal list is in: the agents draw from it at once. */
  readonly terminalsLoaded: boolean;
  /** Why the first terminal list failed, while none has come in; null otherwise. */
  readonly terminalsError: string | null;
  /** Asks the core for the terminal list again. */
  readonly retryTerminals: () => void;
  /** The first machine.list answer (or its failure) is in; until then Spaces holds a loading row in its place. */
  readonly machinesListed: boolean;
  /** Starts a shell on that machine (`terminal.run` with `on`) and opens it at its `machine/tN` address. */
  readonly newTerminalOn: (machine: string) => void;
  /** New terminal with these run parameters; with no `on`, on this machine. */
  readonly start: (params: TerminalRunParams) => void;
  /** Why the last machine.list failed, until one succeeds. */
  readonly listError: string | undefined;
  /** Shows how to add a machine (the pairing commands). */
  readonly openAddMachine: () => void;
  /**
   * The added machines as the page shows them: as machine.list last said (state, `why`, since when), except a machine
   * whose line hc is redialing, which reads reconnecting for `OFFLINE_GRACE_MS` (#904).
   */
  readonly views: readonly MachineView[];
  /** Dials a machine now (`machine.connect`) instead of at hc's next retry, then reads machine.list again. */
  readonly retry: (machine: string) => Promise<void>;
  /** Takes an added machine off the core's machine list (`machine.rm`), so it leaves every device's lists (#2456). */
  readonly remove: (machine: string) => Promise<void>;
  /**
   * Moves a machine (by its permanent core id) to index `to` of `entries` and saves the order for every device;
   * resolves true once saved, false when the move no longer applies or was not saved (the person was told why).
   */
  readonly moveMachine: (core: string, to: number) => Promise<boolean>;
}

export const MachinesContext = createContext<Machines>({
  entries: [],
  terminalsLoaded: true,
  terminalsError: null,
  retryTerminals: () => {},
  machinesListed: true,
  newTerminalOn: () => {},
  start: () => {},
  listError: undefined,
  openAddMachine: () => {},
  views: [],
  retry: async () => {},
  remove: async () => {},
  moveMachine: async () => false,
});

export const useMachinesContext = (): Machines => useContext(MachinesContext);

export interface MachineState {
  readonly entries: readonly MachineEntry[];
  /** The terminals with those on a machine that is not connected marked unreachable (`withReach`). */
  readonly terminals: readonly Session[];
  /** Reads machine.list again now, e.g. after a call on a machine failed. */
  readonly refresh: () => void;
  readonly listError: string | undefined;
  /** The machines as the page shows them: a line hc is redialing reads reconnecting for `OFFLINE_GRACE_MS` (#904). */
  readonly views: readonly MachineView[];
  /** The machines as machine.list last said, with no grace: for checks that must not act on a held state. */
  readonly heard: readonly MachineView[];
  readonly retry: (machine: string) => Promise<void>;
  /** Removes the machine and reads machine.list again before it settles, so this page drops it at once (`removeThenRead`). */
  readonly remove: (machine: string) => Promise<void>;
  /** How many machine.list reads have come back: a tab waits one read before taking a gone terminal as removed. */
  readonly listed: number;
}

/**
 * Runs hc's `machine.rm` and settles on its answer alone: rejects as hc refused, resolves once it removed the machine.
 * The machine.list read after it, so the page drops the machine at once, is best effort and waited for either way; a
 * read that fails goes to `readFailed`, so a machine that was removed is never reported "not removed" and hc's
 * refusal is never replaced by the read's error (#2503 review).
 */
export async function removeThenRead(
  rm: () => Promise<unknown>,
  read: () => Promise<void>,
  readFailed: (cause: unknown) => void,
): Promise<void> {
  try {
    await rm();
  } finally {
    await read().catch(readFailed);
  }
}

/** The shared roster's machines as this page shows them: hc's last answer with the redial grace (#904) laid over it. */
export function useMachines(connection: HcConnection, terminals: readonly Terminal[]): MachineState {
  const { roster, snapshot } = useRoster(connection);
  const read = snapshot.machines;
  const [clock, setClock] = useState(Date.now);
  const now = read.at === undefined ? clock : Math.max(clock, read.at);
  const refresh = useCallback(() => void roster.refreshMachines(), [roster]);
  // A held machine's grace ends between reads: the page shows it offline then, not at the next read up to 10 s later.
  const ends = graceEnds(read.held, now);
  useEffect(() => {
    if (ends === undefined) return undefined;
    // A timer may fire a moment early: `now` is moved to the end itself, so the grace ends and `ends` moves on.
    const timer = setTimeout(() => setClock(Math.max(Date.now(), ends)), Math.max(0, ends - Date.now()));
    return () => clearTimeout(timer);
  }, [ends]);
  const views = useMemo(() => graceViews(read.views, read.held, now), [read, now]);
  const { id: coreId, name: coreName } = connection.hello.core;
  const reached = useMemo(() => withReach(terminals, views), [terminals, views]);
  const entries = useSteady(
    useMemo(() => machineEntries({ id: coreId, name: coreName }, views, reached), [coreId, coreName, views, reached]),
  );
  // A refused dial is not lost: hc records it as the machine's `why`, which the re-read brings in.
  const retry = useCallback(
    (machine: string) => connection.call("machine.connect", { machine }).then(refresh, refresh),
    [connection, refresh],
  );
  const remove = useCallback(
    (machine: string) =>
      removeThenRead(
        () => connection.call("machine.rm", { machine }),
        () => roster.refreshMachines(),
        (cause) => console.error(`read machine.list after removing ${machine}: ${String(cause)}`),
      ),
    [connection, roster],
  );
  return {
    entries,
    terminals: reached,
    refresh,
    listError: read.error,
    views,
    heard: read.views,
    retry,
    remove,
    listed: read.listed,
  };
}
