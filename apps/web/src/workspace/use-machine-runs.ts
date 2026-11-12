import type { HcConnection } from "@doriface/client";
import type { Terminal, TerminalRunParams } from "@doriface/protocol";
import { useToastManager } from "@doriface/ui";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { readDisplay } from "../terminal/display.ts";
import { type Opening, openingCallsOf, openingTerminal, runWithAttach } from "../terminal/opening-attach.ts";
import { machineOf } from "./model.ts";
import { failureNotice, startTerminal } from "./start-on.ts";
import { withoutClaim } from "./use-layout.ts";
import type { TypeAhead } from "./use-type-ahead.ts";
import { machineName } from "../connection/attached-name.ts";

export interface MachineRuns {
  readonly newTerminalOn: (machine: string) => void;
  /**
   * New terminal with these run parameters, on this machine or the one `on` names; `place` puts it somewhere else than a
   * new tab, and `failed` runs when it did not start.
   */
  readonly start: (params: TerminalRunParams, place?: (address: string) => void, failed?: () => void) => void;
}

/**
 * New terminal anywhere: opens it, or reports the failure in a toast, the one surface every layout shows (the phone's
 * empty screen and a hidden sidebar included), and reads machine.list again in case a machine went away. From the
 * moment it is asked for until it is placed, the keyboard is the new terminal's (`typeAhead`).
 *
 * A run whose answer the link lost may have started all the same: the feed lists its terminal, and its tab may already
 * be open. `terminals` is that feed; a live terminal with the opening's name on its machine means the start succeeded,
 * and the press that really failed while reconnecting is the one that reports (#1343).
 */
export function useMachineRuns(
  connection: HcConnection,
  opened: (address: string) => void,
  refresh: () => void,
  typeAhead: TypeAhead,
  terminals: readonly Terminal[],
): MachineRuns {
  const toasts = useToastManager();
  // Read when a run answers, not when it was asked: the feed may list its terminal in between.
  const fed = useRef<readonly Terminal[]>(terminals);
  fed.current = terminals;
  const live = useCallback((opening: Opening): string | null => {
    const found = fed.current.find(
      (terminal) =>
        terminal.state === "live" &&
        terminal.name === opening.name &&
        (machineOf(terminal.address) ?? null) === opening.machine,
    );
    return found?.address ?? null;
  }, []);
  // A run that answers after the workspace closed starts nothing here: no tab, no handing over of held keys (which would
  // wait for a view that never mounts), no toast.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The placement current when a start is asked for, as a closure of that render: by the time the run answers, the
  // terminal is listed (shown alone in a transient tab), and a later placement would find it there and write no tab.
  const openedNow = useRef(opened);
  openedNow.current = opened;
  const start = useCallback(
    (params: TerminalRunParams, place: (address: string) => void = openedNow.current, failed?: () => void): void => {
      const core = machineName(connection);
      const hold = typeAhead.hold();
      const display = readDisplay(document.documentElement);
      const opening = openingTerminal(params);
      // Placed either way; claimed (its view takes the keyboard) only while the keyboard is still the new terminal's.
      const placed = (address: string): void => {
        if (typeAhead.holds(hold, address)) place(address);
        else withoutClaim(() => place(address));
        typeAhead.deliver(hold, address);
      };
      void startTerminal(
        (run) => runWithAttach(connection, openingCallsOf(connection), run, display, opening),
        params,
        core,
      ).then((started) => {
        if (!mounted.current) return undefined;
        if (started.ok) return placed(started.address);
        const openedAnyway = opening === null ? null : live(opening);
        if (openedAnyway !== null) return placed(openedAnyway);
        typeAhead.release(hold);
        toasts.add({ type: "error", ...failureNotice(started.failure, connection.closed, core) });
        failed?.();
        return refresh();
      });
    },
    [connection, live, refresh, toasts, typeAhead],
  );
  const newTerminalOn = useCallback((machine: string): void => start({ on: machine }), [start]);
  return useMemo(() => ({ newTerminalOn, start }), [newTerminalOn, start]);
}
