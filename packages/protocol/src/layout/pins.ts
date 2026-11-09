import { isJsonObject, type JsonObject, type JsonValue } from "../json.ts";

/**
 * Pinned tabs (#1561), kept in the layout document beside order and names so every device shows the same pins: a tab
 * object carries `pinned: true`, and a space's pinned tabs always come first. herdr-app ignores the field.
 */
export const isPinned = (tab: JsonObject): boolean => tab["pinned"] === true;

const text = (value: JsonValue | undefined): string => (typeof value === "string" ? value : "");
const objects = (value: JsonValue | undefined): readonly JsonObject[] =>
  Array.isArray(value) ? value.filter(isJsonObject) : [];

/** The first and last index a tab may move to among `tabs`: pinned ones stay in front, unpinned ones behind them. */
export function moveBounds(tabs: readonly JsonObject[], moving: JsonObject): readonly [number, number] {
  const pinned = tabs.filter(isPinned).length;
  return isPinned(moving) ? [0, pinned - 1] : [pinned, tabs.length - 1];
}

/**
 * The document with a tab pinned (moved to the end of its space's pinned tabs) or unpinned (moved to the start of the
 * unpinned ones); null when the tab is gone or already so, so nothing is written. Everything else stays as read.
 */
export function setPinned(doc: JsonObject, tabId: string, pinned: boolean): JsonObject | null {
  const spaces = objects(doc["spaces"]);
  const at = spaces.findIndex((space) => objects(space["tabs"]).some((tab) => text(tab["id"]) === tabId));
  const space = spaces[at];
  if (space === undefined) return null;
  const tabs = objects(space["tabs"]);
  const moving = tabs.find((tab) => text(tab["id"]) === tabId);
  if (moving === undefined || isPinned(moving) === pinned) return null;
  const { pinned: _was, ...plain } = moving;
  const changed: JsonObject = pinned ? { ...plain, pinned: true } : plain;
  const rest = tabs.filter((tab) => tab !== moving);
  const placed = rest.toSpliced(rest.filter(isPinned).length, 0, changed);
  return { ...doc, spaces: spaces.with(at, { ...space, tabs: placed }) };
}

/**
 * The ids of the tabs "Close tabs to the right" or "Close other tabs" closes from tab `tabId`, in strip order: the tabs
 * of its space after it, or every other one; a pinned tab is never among them, as in a browser.
 */
export function closeSet(doc: JsonObject, tabId: string, which: "right" | "others"): readonly string[] {
  const space = objects(doc["spaces"]).find((each) => objects(each["tabs"]).some((tab) => text(tab["id"]) === tabId));
  const tabs = space === undefined ? [] : objects(space["tabs"]);
  const at = tabs.findIndex((tab) => text(tab["id"]) === tabId);
  if (at === -1) return [];
  const picked = which === "right" ? tabs.slice(at + 1) : tabs.filter((_, index) => index !== at);
  return picked.filter((tab) => !isPinned(tab)).map((tab) => text(tab["id"]));
}
