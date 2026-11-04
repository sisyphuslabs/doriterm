import type { HcConnection } from "@doriface/client";
import { type DocCalls, LayoutDoc } from "@doriface/protocol/layout";
import { useCallback, useEffect, useMemo, useState } from "react";
import { arrangeMachines, moveMachine, ORDER_DOC, readOrderDocument, storedOrder } from "./machine-order.ts";
import type { MachineEntry } from "./machines.ts";

export interface MachineOrder {
  /** The machines in the order the person put them; the default order until the document is read or when never set. */
  readonly entries: readonly MachineEntry[];
  /** Moves a machine (by its permanent id) to index `to` and saves the order; resolves false when it was not saved. */
  readonly move: (core: string, to: number) => Promise<boolean>;
  /** A `doc` event for this core's order document: another device wrote it. */
  readonly heard: (version: number) => void;
}

const orderCalls = (connection: HcConnection): DocCalls => ({
  get: () => connection.call("doc.get", { name: ORDER_DOC }),
  set: (_on, value, version) => connection.call("doc.set", { name: ORDER_DOC, value, version }),
});

/**
 * The person's machine order, kept in the connected core's own `doriface` document the way the split layout is kept in
 * herdr-app's: read on connect and on each `doc` event, every write a compare-and-set that is made again on a conflict.
 */
export function useMachineOrder(connection: HcConnection, entries: readonly MachineEntry[]): MachineOrder {
  const [, rerender] = useState(0);
  const doc = useMemo(
    () => new LayoutDoc(orderCalls(connection), null, () => rerender((count) => count + 1), readOrderDocument),
    [connection],
  );
  useEffect(() => void doc.refresh(), [doc]);
  const state = doc.state;
  const read = state.phase === "ready" ? state.doc : null;
  const arranged = useMemo(() => arrangeMachines(entries, storedOrder(read)), [entries, read]);
  const move = useCallback((core: string, to: number) => doc.edit(moveMachine(entries, core, to)), [doc, entries]);
  const heard = useCallback((version: number): void => void doc.heard(version), [doc]);
  return { entries: arranged, move, heard };
}
