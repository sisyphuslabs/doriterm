import type { HcConnection } from "@doriface/client";
import { storedOrder } from "@doriface/protocol/layout";
import { useCallback, useMemo } from "react";
import { useRoster } from "../roster/use-roster.ts";
import { arrangeMachines, moveMachine } from "./machine-order.ts";
import type { MachineEntry } from "./machines.ts";

export interface MachineOrder {
  /** The machines in the order the person put them; the default order until the document is read or when never set. */
  readonly entries: readonly MachineEntry[];
  /**
   * Moves a machine (by its permanent id) to index `to` and saves the order; resolves false when the move no longer
   * applies, and rejects with the reason when the order document cannot take it (unreadable, not loaded, or beaten on
   * every retry).
   */
  readonly move: (core: string, to: number) => Promise<boolean>;
}

/**
 * The person's machine order, one for every device (#2531): kept in every machine's `doriface` document and read from all
 * of them as one (`SharedOrder`), on connect, on each `doc` event and on every gap; every write is a stamped
 * compare-and-set on each core, made again on a conflict.
 */
export function useMachineOrder(connection: HcConnection, entries: readonly MachineEntry[]): MachineOrder {
  const { roster, snapshot } = useRoster(connection);
  const state = snapshot.order;
  const read = state.phase === "ready" ? state.doc : null;
  const arranged = useMemo(() => arrangeMachines(entries, storedOrder(read)), [entries, read]);
  const move = useCallback(
    (core: string, to: number) => roster.order.edit(moveMachine(entries, core, to)),
    [roster, entries],
  );
  return { entries: arranged, move };
}
