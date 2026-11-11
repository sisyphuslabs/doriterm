import type { HcConnection } from "@doriface/client";
import { HcRpcError, type MachineView, type Terminal } from "@doriface/protocol";
import { useEffect, useMemo, useRef } from "react";
import type { LayoutTab } from "./layout-model.ts";
import type { MachineLayout } from "./use-layout-docs.ts";
import { machineOf } from "./model.ts";

/** The finishes that end a terminal for good, as herdr-app reads them (`checked_closed`): any other may come back. */
const FINAL: ReadonlySet<string> = new Set(["exited", "killed"]);

/** Whether the core's record says the terminal's program is over for good: it exited, or it was killed. */
export const endedForGood = (terminal: Pick<Terminal, "state" | "reason">): boolean =>
  terminal.state === "finished" && FINAL.has(terminal.reason ?? "");

/**
 * The terminals no pane is asked about: the live ones, and one the feed lists as finished while its pane is in view.
 * That pane is its view's to settle: it says "This session ended" and closes from there (#164, #1593), so only a pane
 * out of view goes by itself once its terminal is over (#2122).
 */
export function settledPanes(
  terminals: readonly Pick<Terminal, "address" | "state">[],
  inView: readonly string[],
): Set<string> {
  const watched = new Set(inView);
  return new Set(
    terminals.flatMap((terminal) =>
      terminal.state === "live" || watched.has(terminal.address) ? [terminal.address] : [],
    ),
  );
}

/** The panes in view whose terminal the feed lists as over: each is left to its view, which says the session ended. */
export function endedInView(
  terminals: readonly Pick<Terminal, "address" | "state">[],
  inView: readonly string[],
): Set<string> {
  const watched = new Set(inView);
  return new Set(
    terminals.flatMap((terminal) =>
      terminal.state !== "live" && watched.has(terminal.address) ? [terminal.address] : [],
    ),
  );
}

/**
 * Of the panes this device left to their views (`left`, endedInView, each with the machine whose document showed it),
 * those no tab shows any more while that machine's document is still `written`. An ended pane goes everywhere once any
 * device has it out of view, as herdr-app's `reconcile` drops it whoever looks: the in-view rule is this device's own,
 * so another device can take a pane this one was showing as ended (#2146). A pane that went with its machine or its
 * document went for that reason, not by another device's write (#2231).
 */
export function goneFromView(
  left: ReadonlyMap<string, string | null>,
  tabs: readonly LayoutTab[],
  written: (machine: string | null) => boolean,
): string[] {
  const shown = new Set(tabs.flatMap((tab) => tab.panes.map((pane) => pane.address)));
  return [...left].flatMap(([address, machine]) => (!shown.has(address) && written(machine) ? [address] : []));
}

/** This core's own layout in the written-documents key (its machine is null; no machine name is empty). */
const THIS_CORE = "\u0001";

/** The panes in view whose terminal is over (endedInView), each with the machine of the tab that shows it. */
function leftWithMachines(ended: ReadonlySet<string>, tabs: readonly LayoutTab[]): Map<string, string | null> {
  const machineByPane = new Map(tabs.flatMap((tab) => tab.panes.map((pane) => [pane.address, tab.machine] as const)));
  return new Map([...ended].map((address) => [address, machineByPane.get(address) ?? null]));
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
 * A terminal that ended or was removed while no view of it was attached leaves its pane in the shared layout: a pane
 * attaches only once it is shown (#1187), so in a tab out of view no view ever says that it ended. Once the feed is
 * loaded, each pane whose terminal is not live there is asked about once, as herdr-app's `reconcile` asks on every
 * listing, and it is dropped when the core says not_found, or that its program exited or was killed; any other answer
 * (a terminal the feed lists a moment later, a machine that is offline, a lost holder) keeps it. A pane in view
 * (`inView`) whose terminal is listed finished is left to its view (`settledPanes`). A terminal that is live again is
 * asked about again if it goes later.
 *
 * An added machine's terminals can read as unknown while it reconnects or right after a rename, so its panes are asked
 * about only after `stepMissing`'s wait: absent across two machine.list reads, with the machine connected at both and
 * the feed agreeing with machine.list on its name (`absentRemotePanes`). `reads` counts machine.list answers.
 *
 * A pane left to its view that then goes from every tab is reported to `gone` (goneFromView), so the person who was
 * looking at it is told why it went (#2146).
 */
export function useDeadPanes(
  connection: HcConnection,
  tabs: readonly LayoutTab[],
  terminals: readonly Terminal[] | null,
  machines: readonly MachineView[],
  reads: number,
  drop: (address: string) => void,
  inView: readonly string[],
  gone: (address: string) => void,
  layouts: readonly Pick<MachineLayout, "machine" | "doc">[],
): void {
  const asked = useRef(new Set<string>());
  const left = useRef<ReadonlyMap<string, string | null>>(new Map());
  const viewed = inView.join("\u0000");
  const viewedNow = useRef(inView);
  viewedNow.current = inView;
  const missing = useRef<ReadonlyMap<string, Missing>>(new Map());
  // The machines whose document is written, as one key: `layouts` is a new array each render, its machines seldom change.
  const writtenKey = layouts
    .flatMap((layout) => (layout.doc === null ? [] : [layout.machine ?? THIS_CORE]))
    .join("\u0000");
  const writtenOn = useMemo(() => new Set(writtenKey === "" ? [] : writtenKey.split("\u0000")), [writtenKey]);
  useEffect(() => {
    asked.current = new Set();
    missing.current = new Map();
    left.current = new Map();
  }, [connection]);
  useEffect(() => {
    if (terminals === null) return;
    const feed = new Set(terminals.map((terminal) => terminal.address));
    const watched = viewed === "" ? [] : viewed.split("\u0000");
    const written = (machine: string | null): boolean => writtenOn.has(machine ?? THIS_CORE);
    for (const address of goneFromView(left.current, tabs, written)) gone(address);
    left.current = leftWithMachines(endedInView(terminals, watched), tabs);
    const settled = settledPanes(terminals, watched);
    for (const address of asked.current) if (settled.has(address)) asked.current.delete(address);
    const step = stepMissing(missing.current, absentRemotePanes(tabs, settled, machines, feed), reads);
    missing.current = step.missing;
    for (const address of [...absentPanes(tabs, settled), ...step.ask]) {
      if (asked.current.has(address)) continue;
      asked.current.add(address);
      void connection.call("terminal.get", { terminal: address }).then(
        (terminal) => {
          if (!endedForGood(terminal) || connection.closed) return terminal;
          // Shown since it was asked about: its view says it ended, and it is asked about again once out of view.
          if (viewedNow.current.includes(address)) asked.current.delete(address);
          else drop(address);
          return terminal;
        },
        (cause: unknown) => {
          if (cause instanceof HcRpcError && cause.kind === "not_found" && !connection.closed) drop(address);
        },
      );
    }
  }, [connection, tabs, terminals, machines, reads, drop, viewed, gone, writtenOn]);
}
