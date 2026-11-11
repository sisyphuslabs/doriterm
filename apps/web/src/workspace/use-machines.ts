import type { HcConnection } from "@doriface/client";
import type { MachineView, Terminal, TerminalRunParams } from "@doriface/protocol";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { graceEnds, graceViews, stepHeld, type Held } from "./machine-grace.ts";
import { machineEntries, machineKey, orderMachines, type MachineEntry } from "./machines.ts";
import type { Session } from "./model.ts";
import { withReach } from "./reach.ts";
import { useSteady } from "./steady.ts";

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
  moveMachine: async () => false,
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
  /** The machines as the page shows them: a line hc is redialing reads reconnecting for `OFFLINE_GRACE_MS` (#904). */
  readonly views: readonly MachineView[];
  /** The machines as machine.list last said, with no grace: for checks that must not act on a held state. */
  readonly heard: readonly MachineView[];
  readonly retry: (machine: string) => Promise<void>;
  /** How many machine.list reads have come back: a tab waits one read before taking a gone terminal as removed. */
  readonly listed: number;
}

/** machine.list, read again when a machine's live terminals change, on a timer while visible, and on return. */
export function useMachines(connection: HcConnection, terminals: readonly Terminal[]): MachineState {
  const [read, setRead] = useState<{
    readonly views: readonly MachineView[];
    readonly at: number | undefined;
    readonly first?: { readonly at: number; readonly ids: ReadonlySet<string> };
    readonly up?: ReadonlySet<string>;
    readonly held: Held;
  }>({ views: [], at: undefined, held: new Map() });
  const [now, setNow] = useState(Date.now);
  const [reads, setReads] = useState(0);
  const [listError, setListError] = useState<string | undefined>(undefined);
  const [listed, setListed] = useState(0);
  const refresh = useCallback(() => setReads((count) => count + 1), []);
  const key = machineKey(terminals);
  // Each read is numbered when sent. An answer applies unless a later-sent read's answer was already applied, so an
  // answer slower than the refresh period still draws, and an old answer never overwrites a newer one.
  const sentSeq = useRef(0);
  const appliedSeq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    sentSeq.current += 1;
    const seq = sentSeq.current;
    const fresh = (): boolean => mounted.current && seq > appliedSeq.current;
    connection.call("machine.list").then(
      (list) => {
        if (!fresh()) return list;
        appliedSeq.current = seq;
        const at = Date.now();
        setRead((before) => {
          const views = orderMachines(list.machines);
          const first = before.first ?? { at, ids: new Set(views.map((view) => view.id)) };
          const up = new Set(before.up);
          for (const view of views) if (view.state === "connected") up.add(view.id);
          return { views, at, first, up, held: stepHeld(before.held, before, views, at) };
        });
        setNow(at);
        setListError(undefined);
        setListed((count) => count + 1);
        return list;
      },
      (error: unknown) => {
        if (!fresh()) return;
        appliedSeq.current = seq;
        setListError(error instanceof Error ? error.message : String(error));
      },
    );
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
  // A held machine's grace ends between reads: the page shows it offline then, not at the next read up to 10 s later.
  const ends = graceEnds(read.held, now);
  useEffect(() => {
    if (ends === undefined) return undefined;
    // A timer may fire a moment early: `now` is moved to the end itself, so the grace ends and `ends` moves on.
    const timer = setTimeout(() => setNow(Math.max(Date.now(), ends)), Math.max(0, ends - Date.now()));
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
  return { entries, terminals: reached, refresh, listError, views, heard: read.views, retry, listed };
}
