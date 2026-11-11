import type { Terminal } from "@doriface/protocol";
import { useEffect, useRef } from "react";
import { adoptLoose } from "./layout-model.ts";
import { machineOf } from "./model.ts";
import type { MachineLayout } from "./use-layout-docs.ts";

/**
 * Adopts the live terminals no tab shows into their machine's layout (#404, see adoptLoose): once per machine, as its
 * layout first loads and takes edits and the feed has listed the terminals (`terminals` null until then). Terminals
 * that start later are placed by whoever starts them. A refused write is said by `failed` and tried again on the next
 * load of the page. The adoption shows once saved: another device opening now adopts the same terminals under other
 * ids, and whichever write the host takes is the one every device lists (#1572).
 */
export function useAdoptLoose(
  layouts: readonly MachineLayout[],
  terminals: readonly Terminal[] | null,
  failed: (message: string) => void,
): void {
  const adopted = useRef(new Set<string>());
  useEffect(() => {
    if (terminals === null) return;
    for (const layout of layouts) {
      const key = layout.machineId ?? "";
      if (adopted.current.has(key) || !layout.loaded || layout.readOnly !== null) continue;
      adopted.current.add(key);
      const own = terminals.filter((terminal) => (machineOf(terminal.address) ?? null) === layout.machine);
      void layout
        .edit((doc) => adoptLoose(doc, own), "once saved")
        .catch((cause: unknown) => failed(cause instanceof Error ? cause.message : String(cause)));
    }
  }, [failed, layouts, terminals]);
}
