import { isJsonObject, type JsonObject, type JsonValue } from "../json.ts";
import type { ReadDocument } from "./document.ts";
import type { DocEdit } from "./sync.ts";

/**
 * doriface's own document on a core, beside herdr-app's: herdr-app rewrites its document from a struct that has only
 * `spaces` (`src/mirror.rs`), so a field doriface put there would be gone the next time herdr-app saved a layout.
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
 * The ids in the order the person put them: the ones the stored order names, in its order, then every id it does not
 * name (added since) in the order `live` lists them. Stored ids that are not live (removed, revoked) drop out.
 */
export function arrangeIds(live: readonly string[], stored: readonly string[] | null): readonly string[] {
  if (stored === null) return live;
  const present = new Set(live);
  const placed = [...new Set(stored)].filter((id) => present.has(id));
  const named = new Set(placed);
  return [...placed, ...live.filter((id) => !named.has(id))];
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
 * The edit that moves one machine among `live` (in default order), made on whatever document is current when it is
 * written: after a refused compare-and-set it runs again on the other device's order. Every other field is kept.
 */
export function moveInOrder(live: readonly string[], id: string, to: number): DocEdit {
  return (doc) => {
    const next = movedOrder(arrangeIds(live, storedOrder(doc)), id, to);
    return next === null ? null : { ...doc, [ORDER_FIELD]: [...next] };
  };
}
