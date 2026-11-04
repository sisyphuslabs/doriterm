import { arrangeIds, type DocEdit, moveInOrder } from "@doriface/protocol/layout";
import type { MachineEntry } from "./machines.ts";

/**
 * The list as the person ordered it (`arrangeIds`): machines are matched by their permanent core id, so a renamed
 * machine keeps its place, and the ones the stored order does not name follow in the default order.
 */
export function arrangeMachines(entries: readonly MachineEntry[], stored: readonly string[] | null): MachineEntry[] {
  const byId = new Map(entries.map((entry) => [entry.core, entry]));
  return arrangeIds(
    entries.map((entry) => entry.core),
    stored,
  ).flatMap((id) => byId.get(id) ?? []);
}

/** The edit that moves one machine (by core id) to index `to` of the list as it stands when it is written. */
export const moveMachine = (entries: readonly MachineEntry[], core: string, to: number): DocEdit =>
  moveInOrder(
    entries.map((entry) => entry.core),
    core,
    to,
  );
