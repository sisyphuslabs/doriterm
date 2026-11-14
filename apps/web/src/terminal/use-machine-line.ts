import type { HcConnection } from "@doriface/client";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { machineOf } from "../workspace/model.ts";
import { type MachineLines, machineLines } from "./machine-lines.ts";

/**
 * The added machine a terminal in view is on, while its line is down (its input waits, #1489); null otherwise. Reads
 * the machine's line while the view is shown, so a drop is noticed within a read instead of at the page's slower one.
 */
export function useMachineLine(
  connection: HcConnection,
  address: string,
  shown: boolean,
  lines: MachineLines = machineLines,
): string | null {
  const machine = machineOf(address);
  useEffect(
    () => (machine === undefined || !shown ? undefined : lines.watch(connection)),
    [connection, machine, shown, lines],
  );
  const subscribe = useCallback((changed: () => void) => lines.subscribe(changed), [lines]);
  const down = useSyncExternalStore(subscribe, () => (machine === undefined ? false : lines.down(connection, machine)));
  return down && machine !== undefined ? machine : null;
}
