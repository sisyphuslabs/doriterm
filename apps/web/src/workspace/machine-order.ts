import { isJsonObject, type JsonObject, type JsonValue } from "@doriface/protocol";
import type { DocEdit, ReadDocument } from "@doriface/protocol/layout";
import type { MachineEntry } from "./machines.ts";

/**
 * doriface's own document on the connected core, beside herdr-app's: herdr-app rewrites its document from a struct
 * that has only `spaces`, so a field doriface put there would be gone the next time herdr-app saved a layout.
 */
export const ORDER_DOC = "doriface";
const ORDER_FIELD = "machine_order";

/** The document's reading rules: missing means never written; anything but a list of ids refuses edits, never guessed at. */
export function readOrderDocument(value: JsonValue): ReadDocument {
  if (value === null) return { kind: "empty" };
  if (!isJsonObject(value)) return { kind: "unreadable", reason: "an order document that is not an object" };
  const order = value[ORDER_FIELD];
  if (order === undefined) return { kind: "ok", doc: value };
  if (!Array.isArray(order) || !order.every((id) => typeof id === "string"))
    return { kind: "unreadable", reason: "a machine order that is not a list of machine ids" };
  return { kind: "ok", doc: value };
}

/** The machine ids in the order the person put them, or null when they never moved one. */
export function storedOrder(doc: JsonObject | null): readonly string[] | null {
  const order = doc?.[ORDER_FIELD];
  return Array.isArray(order) ? order.filter((id): id is string => typeof id === "string") : null;
}

/**
 * The list as the person ordered it: machines the stored order names, in its order; then every machine it does not name
 * (added since), in the default order (this machine first, then by name). Ids of machines that are gone drop out.
 * Machines are matched by their permanent id, so a renamed machine keeps its place.
 */
export function arrangeMachines(entries: readonly MachineEntry[], stored: readonly string[] | null): MachineEntry[] {
  if (stored === null) return [...entries];
  const byId = new Map(entries.map((entry) => [entry.core, entry]));
  const placed = [...new Set(stored)].flatMap((id) => byId.get(id) ?? []);
  const named = new Set(placed.map((entry) => entry.core));
  return [...placed, ...entries.filter((entry) => !named.has(entry.core))];
}

/** `ids` with `id` moved to index `to` (clamped to the list), or null when it is not there or would not move. */
export function movedOrder(ids: readonly string[], id: string, to: number): readonly string[] | null {
  const from = ids.indexOf(id);
  const at = Math.max(0, Math.min(ids.length - 1, to));
  if (from === -1 || from === at) return null;
  const rest = ids.filter((each) => each !== id);
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/**
 * The edit that moves one machine, made on whatever document is current when it is written: after a refused
 * compare-and-set it runs again on the other device's order. Every other field of the document is kept as it was read.
 */
export function moveMachine(entries: readonly MachineEntry[], id: string, to: number): DocEdit {
  return (doc) => {
    const current = arrangeMachines(entries, storedOrder(doc)).map((entry) => entry.core);
    const next = movedOrder(current, id, to);
    return next === null ? null : { ...doc, [ORDER_FIELD]: [...next] };
  };
}
