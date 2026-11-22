import type { HcConnection } from "@doriface/client";
import { HcRpcError, type MachineView, type Terminal } from "@doriface/protocol";
import { useEffect, useRef, useState } from "react";
import type { LayoutTab } from "./layout-model.ts";
import { machineOf } from "./model.ts";

/** The finishes that end a terminal for good, as herdr-app reads them (`checked_closed`): any other may come back. */
const FINAL: ReadonlySet<string> = new Set(["exited", "killed"]);

/** Whether the core's record says the terminal's program is over for good: it exited, or it was killed. */
export const endedForGood = (terminal: Pick<Terminal, "state" | "reason">): boolean =>
  terminal.state === "finished" && FINAL.has(terminal.reason ?? "");

/**
 * How long a terminal that ended keeps its pane from when it started, as herdr-app's `just_born` waits before it asks
 * about a pane: a program that fails at launch shows its pane, and how it ended, for that long.
 */
export const JUST_BORN_MS = 5_000;

/** How long a terminal started at `createdMs` still has of its just-born grace at `now`: 0 once it is over. */
export const graceLeft = (createdMs: number, now: number): number => Math.max(0, createdMs + JUST_BORN_MS - now);

/**
 * Runs `then`, which takes a pane whose program ended away, once the terminal is past its just-born grace: at once for
 * one that started JUST_BORN_MS ago or more, so a program that fails at launch shows how it ended for that long, as
 * herdr-app keeps a just-born terminal's pane. A terminal the feed has not listed has no start to wait from.
 */
export function afterGrace(createdMs: number | undefined, then: () => void): void {
  const wait = createdMs === undefined ? 0 : graceLeft(createdMs, Date.now());
  if (wait === 0) then();
  else setTimeout(then, wait);
}

/**
 * The terminals no pane is asked about at `now`: the live ones, and one that ended within JUST_BORN_MS of its start
 * until that grace is over (`wake`: the earliest such end, when to look again). Every other pane whose terminal is
 * over goes, in view or not, as herdr-app's `checked_closed` removes it: the tabs mirror the core's terminals (Q,
 * 2026-11-15), superseding the in-view "This session ended" pane of #164 and #1593.
 */
export function settledPanes(
  terminals: readonly Pick<Terminal, "address" | "state" | "created_ms">[],
  now: number,
): { readonly settled: Set<string>; readonly wake: number | undefined } {
  const young = terminals.filter((terminal) => terminal.state !== "live" && graceLeft(terminal.created_ms, now) > 0);
  return {
    settled: new Set(
      terminals.flatMap((terminal) =>
        terminal.state === "live" || young.includes(terminal) ? [terminal.address] : [],
      ),
    ),
    wake: young.length === 0 ? undefined : Math.min(...young.map((terminal) => terminal.created_ms + JUST_BORN_MS)),
  };
}

/** The terminals this core's document panes show that are not settled (`listed`), each once; panels have none. */
export function absentPanes(tabs: readonly LayoutTab[], listed: ReadonlySet<string>): string[] {
  const addresses = tabs.flatMap((tab) =>
    tab.transient || tab.machine !== null
      ? []
      : tab.panes.flatMap((pane) => (pane.address === null ? [] : [pane.address])),
  );
  return [...new Set(addresses.filter((address) => !listed.has(address)))];
}

/**
 * The terminals an added machine's document panes show that are not settled (`listed`), each with that machine's
 * permanent id, for machines machine.list says are connected. While the feed (`feed`: every address it lists, finished
 * ones too) still names a machine machine.list no longer does (a rename read on one side only), nothing is returned:
 * the two disagree, and a live terminal would read as gone.
 */
export function absentRemotePanes(
  tabs: readonly LayoutTab[],
  listed: ReadonlySet<string>,
  machines: readonly MachineView[],
  feed: ReadonlySet<string> = listed,
): ReadonlyMap<string, string> {
  const known = new Set(machines.map((machine) => machine.name));
  for (const address of feed) {
    const machine = machineOf(address);
    if (machine !== undefined && !known.has(machine)) return new Map();
  }
  const connected = new Map(
    machines.filter((machine) => machine.state === "connected").map((machine) => [machine.name, machine.id]),
  );
  const absent = new Map<string, string>();
  for (const tab of tabs) {
    const id = tab.machine === null ? undefined : connected.get(tab.machine);
    if (tab.transient || id === undefined) continue;
    for (const pane of tab.panes) if (pane.address !== null && !listed.has(pane.address)) absent.set(pane.address, id);
  }
  return absent;
}

/** When an added machine's pane was first seen absent: at which machine.list read, and on which machine (by id). */
export interface Missing {
  readonly read: number;
  readonly machine: string;
}

/**
 * One step of the added machines' wait, as dev's tabs waited before the split stack: a pane absent now is noted with
 * the machine.list read it was first seen at, and is asked about only once a later read still finds it absent on the
 * same connected machine. A pane listed again, or whose machine drops, is renamed or turns into another, starts over.
 */
export function stepMissing(
  missing: ReadonlyMap<string, Missing>,
  absent: ReadonlyMap<string, string>,
  read: number,
): { readonly missing: ReadonlyMap<string, Missing>; readonly ask: readonly string[] } {
  const next = new Map<string, Missing>();
  const ask: string[] = [];
  for (const [address, machine] of absent) {
    const seen = missing.get(address);
    if (seen === undefined || seen.machine !== machine) next.set(address, { read, machine });
    else {
      next.set(address, seen);
      if (read > seen.read) ask.push(address);
    }
  }
  return { missing: next, ask };
}

/**
 * Keeps the panes to the core's terminals, as herdr-app's `reconcile` does on every listing: once the feed is loaded,
 * each pane whose terminal is not live there (past its just-born grace, `settledPanes`) is asked about once, and it is
 * dropped, in view or not, when the core says
 * not_found (removed, as by `hc rm`) or that its program exited or was killed. Any other answer (a terminal the feed
 * lists a moment later, a machine that is offline, a lost holder) keeps it. A terminal that is live again is asked
 * about again if it goes later.
 *
 * An added machine's terminals can read as unknown while it reconnects or right after a rename, so its panes are asked
 * about only after `stepMissing`'s wait: absent across two machine.list reads, with the machine connected at both and
 * the feed agreeing with machine.list on its name (`absentRemotePanes`). `reads` counts machine.list answers.
 */
export function useDeadPanes(
  connection: HcConnection,
  tabs: readonly LayoutTab[],
  terminals: readonly Terminal[] | null,
  machines: readonly MachineView[],
  reads: number,
  drop: (address: string) => void,
): void {
  const asked = useRef(new Set<string>());
  const missing = useRef<ReadonlyMap<string, Missing>>(new Map());
  // A look repeated when a young terminal's grace ends, with no feed event to bring one.
  const [looks, lookAgain] = useState(0);
  useEffect(() => {
    asked.current = new Set();
    missing.current = new Map();
  }, [connection]);
  useEffect(() => {
    if (terminals === null) return undefined;
    const feed = new Set(terminals.map((terminal) => terminal.address));
    const { settled, wake } = settledPanes(terminals, Date.now());
    for (const address of asked.current) if (settled.has(address)) asked.current.delete(address);
    const step = stepMissing(missing.current, absentRemotePanes(tabs, settled, machines, feed), reads);
    missing.current = step.missing;
    for (const address of [...absentPanes(tabs, settled), ...step.ask]) {
      if (asked.current.has(address)) continue;
      asked.current.add(address);
      void connection.call("terminal.get", { terminal: address }).then(
        (terminal) => {
          if (endedForGood(terminal) && !connection.closed) drop(address);
          return terminal;
        },
        (cause: unknown) => {
          if (cause instanceof HcRpcError && cause.kind === "not_found" && !connection.closed) drop(address);
        },
      );
    }
    if (wake === undefined) return undefined;
    // No feed event may come when a young terminal's grace ends, so the look is repeated then.
    const timer = setTimeout(() => lookAgain((count) => count + 1), Math.max(0, wake - Date.now()));
    return () => clearTimeout(timer);
  }, [connection, tabs, terminals, machines, reads, drop, looks]);
}
