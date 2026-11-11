import type { HcConnection } from "@doriface/client";
import type { Terminal } from "@doriface/protocol";
import { useEffect, useRef, useState } from "react";
import { type Look, looseTerminals, stepAdoption } from "./adoption.ts";
import { adoptLoose } from "./layout-model.ts";
import { machineOf } from "./model.ts";
import type { MachineLayout } from "./use-layout-docs.ts";

/**
 * Adopts the live terminals no tab shows into their machine's layout (#404, see adoptLoose), and keeps doing so while
 * the page is open, as herdr-app's `reconcile` places terminals on every listing (#2122): once the feed has listed the
 * terminals (`terminals` null until then), each look at a machine whose layout is loaded and takes edits adopts what
 * `stepAdoption` says is due. A machine's first look adopts everything at once; a terminal that starts later (by
 * `hc run`, an agent, another device) is adopted a grace after it was first seen in no tab, so whoever started it
 * places it first. A refused write is said by `failed` once and tried again on the next connection. The adoption shows
 * once saved: another device adopts the same terminals under other ids, and whichever write the host takes is the one
 * every device lists (#1572).
 */
export function useAdoptLoose(
  connection: HcConnection,
  layouts: readonly MachineLayout[],
  terminals: readonly Terminal[] | null,
  failed: (message: string) => void,
): void {
  const looks = useRef(new Map<string, Look>());
  const [, lookAgain] = useState(0);
  useEffect(() => {
    for (const [machine, look] of looks.current) looks.current.set(machine, { since: look.since, tried: new Set() });
  }, [connection]);
  useEffect(() => {
    if (terminals === null) return undefined;
    const now = Date.now();
    const wakes: number[] = [];
    for (const layout of layouts) {
      if (!layout.loaded || layout.readOnly !== null) continue;
      const key = layout.machineId ?? "";
      const own = terminals.filter((terminal) => (machineOf(terminal.address) ?? null) === layout.machine);
      const loose = looseTerminals(layout.doc, own);
      const step = stepAdoption(
        looks.current.get(key),
        loose.map((terminal) => terminal.address),
        now,
      );
      looks.current.set(key, step.look);
      if (step.wake !== undefined) wakes.push(step.wake);
      if (step.adopt.length === 0) continue;
      const due = loose.filter((terminal) => step.adopt.includes(terminal.address));
      void layout
        .edit((doc) => adoptLoose(doc, due), "once saved")
        .catch((cause: unknown) => failed(cause instanceof Error ? cause.message : String(cause)));
    }
    if (wakes.length === 0) return undefined;
    // No feed event may come before a waiting terminal is due, so the look is repeated then.
    const timer = setTimeout(() => lookAgain((count) => count + 1), Math.max(0, Math.min(...wakes) - Date.now()));
    return () => clearTimeout(timer);
  }, [failed, layouts, terminals]);
}
