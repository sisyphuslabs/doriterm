import { isJsonObject, type JsonObject, type JsonValue } from "../json.ts";
import type { ReadDocument } from "./document.ts";
import type { DocEdit } from "./sync.ts";

/**
 * Pinned tabs (#1561), kept in doriface's own document on each machine's core beside its herdr-app document, so every
 * device shows the same pins: herdr-app rewrites its document from a struct with only `id`, `name` and `root` per tab
 * (`src/mirror.rs`), so a pin kept on the tab would be gone the next time herdr-app saved a layout (as with ORDER_DOC).
 * A space's pinned tabs always come first in the herdr-app document's tab order, which herdr-app keeps.
 */
export const PINS_DOC = "doriface-pins";
const PINS_FIELD = "pinned_tabs";

const NO_PINS: ReadonlySet<string> = new Set();

/** The document's reading rules: missing means never written; anything but a list of tab ids refuses edits. */
export function readPinsDocument(value: JsonValue): ReadDocument {
  if (value === null) return { kind: "empty" };
  if (!isJsonObject(value)) return { kind: "unreadable", reason: "a pins document that is not an object" };
  const pins = value[PINS_FIELD];
  if (pins !== undefined && (!Array.isArray(pins) || !pins.every((id) => typeof id === "string")))
    return { kind: "unreadable", reason: "pinned tabs that are not a list of tab ids" };
  return { kind: "ok", doc: value };
}

/** The ids of the pinned tabs the document names; none when it was never written. */
export function storedPins(doc: JsonObject | null): ReadonlySet<string> {
  const pins = doc?.[PINS_FIELD];
  return Array.isArray(pins) ? new Set(pins.filter((id): id is string => typeof id === "string")) : NO_PINS;
}

/**
 * The edit that pins or unpins tab `tabId` in the pins document, made on whatever document is current when it is written;
 * ids not in `live` (tabs closed since) drop out. Null when the tab is already so. Every other field is kept.
 */
export function pinEdit(live: readonly string[], tabId: string, pinned: boolean): DocEdit {
  return (doc) => {
    const pins = storedPins(doc);
    if (pins.has(tabId) === pinned) return null;
    const present = new Set(live);
    const kept = [...pins].filter((id) => id !== tabId && present.has(id));
    return { ...doc, [PINS_FIELD]: pinned ? [...kept, tabId] : kept };
  };
}

const text = (value: JsonValue | undefined): string => (typeof value === "string" ? value : "");
const objects = (value: JsonValue | undefined): readonly JsonObject[] =>
  Array.isArray(value) ? value.filter(isJsonObject) : [];
const pinnedIn = (pins: ReadonlySet<string>) => (tab: JsonObject) => pins.has(text(tab["id"]));

/**
 * A space's tabs with its pinned ones in front, each group in the document's order. The app writes pinned tabs first,
 * but a document an older client or herdr-app wrote can hold one further on; it is read, and moved, as if in front (#1916).
 */
export function pinnedFirst(tabs: readonly JsonObject[], pins: ReadonlySet<string>): readonly JsonObject[] {
  if (pins.size === 0) return tabs;
  const pinned = pinnedIn(pins);
  return [...tabs.filter(pinned), ...tabs.filter((tab) => !pinned(tab))];
}

/** The first and last index a tab may move to among `tabs`: pinned ones stay in front, unpinned ones behind them. */
export function moveBounds(
  tabs: readonly JsonObject[],
  moving: JsonObject,
  pins: ReadonlySet<string>,
): readonly [number, number] {
  const pinned = tabs.filter(pinnedIn(pins)).length;
  return pins.has(text(moving["id"])) ? [0, pinned - 1] : [pinned, tabs.length - 1];
}

/**
 * The herdr-app document with a tab placed where a pin or unpin puts it: right after its space's other pinned tabs (the
 * end of the pinned ones, or the start of the unpinned ones); null when the tab is gone or already there, so nothing is
 * written. The pin itself goes in the pins document (`pinEdit`), never in this one.
 */
export function placePinned(doc: JsonObject, tabId: string, pins: ReadonlySet<string>): JsonObject | null {
  const spaces = objects(doc["spaces"]);
  const at = spaces.findIndex((space) => objects(space["tabs"]).some((tab) => text(tab["id"]) === tabId));
  const space = spaces[at];
  if (space === undefined) return null;
  const tabs = objects(space["tabs"]);
  const moving = tabs.find((tab) => text(tab["id"]) === tabId);
  if (moving === undefined) return null;
  // Placed in the order the strip shows (#1916): in a document holding a pinned tab further on, the count alone would
  // put this one before it.
  const rest = pinnedFirst(tabs, pins).filter((tab) => tab !== moving);
  const placed = rest.toSpliced(rest.filter(pinnedIn(pins)).length, 0, moving);
  if (placed.every((tab, index) => tab === tabs[index])) return null;
  return { ...doc, spaces: spaces.with(at, { ...space, tabs: placed }) };
}

/**
 * The ids of the tabs "Close tabs to the right" or "Close other tabs" closes from tab `tabId`, in strip order: the tabs
 * of its space after it, or every other one; a pinned tab is never among them, as in a browser.
 */
export function closeSet(
  doc: JsonObject,
  tabId: string,
  which: "right" | "others",
  pins: ReadonlySet<string>,
): readonly string[] {
  const space = objects(doc["spaces"]).find((each) => objects(each["tabs"]).some((tab) => text(tab["id"]) === tabId));
  const tabs = space === undefined ? [] : pinnedFirst(objects(space["tabs"]), pins);
  const at = tabs.findIndex((tab) => text(tab["id"]) === tabId);
  if (at === -1) return [];
  const picked = which === "right" ? tabs.slice(at + 1) : tabs.filter((_, index) => index !== at);
  return picked.filter((tab) => !pins.has(text(tab["id"]))).map((tab) => text(tab["id"]));
}
