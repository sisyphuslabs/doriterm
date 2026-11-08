import type { HcConnection } from "@doriface/client";
import type { TerminalRunParams } from "@doriface/protocol";
import { useToastManager } from "@doriface/ui";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { readDisplay } from "../terminal/display.ts";
import { openingCallsOf, runWithAttach } from "../terminal/opening-attach.ts";
import { failureNotice, startTerminal } from "./start-on.ts";
import { withoutClaim } from "./use-layout.ts";
import type { TypeAhead } from "./use-type-ahead.ts";

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
 */
export function useMachineRuns(
  connection: HcConnection,
  opened: (address: string) => void,
  refresh: () => void,
  typeAhead: TypeAhead,
): MachineRuns {
  const toasts = useToastManager();
  // A run that answers after the workspace closed starts nothing here: no tab, no handing over of held keys (which would
  // wait for a view that never mounts), no toast.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const start = useCallback(
    (params: TerminalRunParams, place: (address: string) => void = opened, failed?: () => void): void => {
      const core = connection.hello.core.name;
      const hold = typeAhead.hold();
      const display = readDisplay(document.documentElement);
      void startTerminal(
        (run) => runWithAttach(connection, openingCallsOf(connection), run, display),
        params,
        core,
      ).then((started) => {
        if (!mounted.current) return undefined;
        if (started.ok) {
          // Placed either way; claimed (its view takes the keyboard) only while the keyboard is still the new terminal's.
          if (typeAhead.holds(hold, started.address)) place(started.address);
          else withoutClaim(() => place(started.address));
          return typeAhead.deliver(hold, started.address);
        }
        typeAhead.release(hold);
        toasts.add({ type: "error", ...failureNotice(started.failure, connection.closed, core) });
        failed?.();
        return refresh();
      });
    },
    [connection, opened, refresh, toasts, typeAhead],
  );
  const newTerminalOn = useCallback((machine: string): void => start({ on: machine }), [start]);
  return useMemo(() => ({ newTerminalOn, start }), [newTerminalOn, start]);
}
