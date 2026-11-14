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

const STAMP_FIELD = "order_stamp";

/**
 * Which write of the shared machine order a copy holds (#2531). The order is kept on every machine's core, and each write
 * carries a stamp: `n` counts writes (one more than the copy it was made on, so a write made on the newest copy always
 * wins whatever the clocks say), `at` is the writer's clock and `by` the writing device, the tie-breaks for two writes
 * made on the same copy while they could not see each other.
 */
export interface OrderRank {
  readonly n: number;
  readonly at: number;
  readonly by: string;
}

/** Whether `a` is a later write than `b`; no stamp at all is older than any stamp. */
export function laterRank(a: OrderRank | null, b: OrderRank | null): boolean {
  if (a === null) return false;
  if (b === null) return true;
  if (a.n !== b.n) return a.n > b.n;
  if (a.at !== b.at) return a.at > b.at;
  return a.by > b.by;
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * The rank of the write a copy holds, or null for a copy no stamped write reached. The stamp records the order it was
 * written with: a copy whose order differs was moved since by a client that keeps the stamp it found without writing its
 * own (a version before the shared order), and ranks just above the write it was made on and below any later one.
 */
/** The `by` of a rank a copy has when an older client moved it: what follows is the order it holds. */
export const MOVED = "moved:";

export function orderRank(doc: JsonObject | null): OrderRank | null {
  const stamp = doc?.[STAMP_FIELD];
  if (!isJsonObject(stamp)) return null;
  const { n, at, by, order } = stamp;
  if (typeof n !== "number" || typeof at !== "number" || typeof by !== "string" || !Array.isArray(order)) return null;
  const written = order.filter((id): id is string => typeof id === "string");
  if (sameIds(written, storedOrder(doc) ?? [])) return { n, at, by };
  // Two copies moved this way on top of the same write tie on n and at; the order itself breaks the tie, so every
  // device picks the same one whichever copy it reads first (#2534 review).
  return { n: n + 1, at: 0, by: `${MOVED}${(storedOrder(doc) ?? []).join(",")}` };
}

/** `doc` as the write `rank` makes it: its order, stamped with the rank and the order it was written with. */
export function stampOrder(doc: JsonObject, rank: OrderRank): JsonObject {
  return { ...doc, [STAMP_FIELD]: { ...rank, order: [...(storedOrder(doc) ?? [])] } };
}

/**
 * One order from copies no stamped write reached yet, the per-machine orders kept before the order was shared: the first
 * copy's order (the routing core's), then each id a later copy names that is not placed yet, in that copy's order.
 */
export function mergedOrders(copies: readonly (JsonObject | null)[]): readonly string[] | null {
  const orders = copies.flatMap((doc) => storedOrder(doc) ?? []);
  return copies.some((doc) => storedOrder(doc) !== null) ? [...new Set(orders)] : null;
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
