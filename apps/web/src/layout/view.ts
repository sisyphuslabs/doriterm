import { isJsonObject } from "@doriface/protocol";
import { browserStorage, guardedLocalStorage } from "../storage/guarded.ts";
import { storedSeen, storedView, viewOn } from "./view-keys.ts";

/** A terminal's address to the moment of a finish this screen has shown: herdr-app's seen attention (`view.json`). */
export type Seen = Readonly<Record<string, string>>;

/**
 * What this screen looks at, kept out of the shared document as herdr-app keeps its `view.json` (`src/mirror.rs`
 * `View`): the selected tab, the tab each space last showed (`spaces`, keyed by `spaceKey`) so picking a space brings its
 * tab back, per tab the focused and zoomed pane, and the finishes it has already looked at (`seen`, #611). Tabs are keyed
 * by tab key (`tabKey`), per core. The tabs' order is the documents' own, so every device shows it the same.
 */
export interface View {
  readonly active: string | null;
  readonly focused: Readonly<Record<string, string>>;
  readonly zoomed: Readonly<Record<string, string>>;
  readonly spaces: Readonly<Record<string, string>>;
  readonly seen: Seen;
}

export const NO_VIEW: View = { active: null, focused: {}, zoomed: {}, spaces: {}, seen: {} };

/** One view per device (#2537); before, one per host the page went through, which a route change lost. */
export const VIEW_KEY = "doriface.view";
const perHostKey = (core: string): string => `doriface.view.${core}`;

function strings(value: unknown): Record<string, string> {
  if (!isJsonObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function parsedView(text: string | null): View | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text ?? "null");
  } catch {
    return null;
  }
  if (!isJsonObject(parsed)) return null;
  const active = parsed["active"];
  return {
    active: typeof active === "string" ? active : null,
    focused: strings(parsed["focused"]),
    zoomed: strings(parsed["zoomed"]),
    spaces: strings(parsed["spaces"]),
    seen: strings(parsed["seen"]),
  };
}

/** The per-host views saved before #2537 (`doriface.view.<core id>`), by the core each was saved through. */
export function perHostViews(
  storage: Pick<Storage, "getItem" | "key" | "length"> | undefined = Reflect.get(globalThis, "localStorage"),
): readonly string[] {
  const cores: string[] = [];
  try {
    for (let at = 0; at < (storage?.length ?? 0); at += 1) {
      const key = storage?.key(at);
      if (key?.startsWith(`${VIEW_KEY}.`) === true) cores.push(key.slice(VIEW_KEY.length + 1));
    }
  } catch {
    return [];
  }
  return cores;
}

/** An old per-host view in the stored form: its bare keys, seen marks included, are the core it was saved through. */
function fromPerHost(view: View, core: string): View {
  const stored = storedView(view, core);
  return { ...stored, seen: storedSeen(view.seen, core, { byName: new Map(), byId: new Map() }) };
}

/**
 * This device's view, keyed as this page keys it when it goes through `core` (seen marks stay in the stored form, see
 * `seenOn`). A device with only the per-host views saved before #2537 starts from all of them merged, the one it kept
 * for this host winning where they overlap.
 */
export function loadView(
  core: string,
  storage: Pick<Storage, "getItem"> = guardedLocalStorage(),
  oldCores: readonly string[] = perHostViews(),
): View {
  const stored = parsedView(storage.getItem(VIEW_KEY));
  if (stored !== null) return viewOn(stored, core);
  const merged = [...oldCores.filter((old) => old !== core), core].reduce<View>((into, old) => {
    const view = parsedView(storage.getItem(perHostKey(old)));
    if (view === null) return into;
    const kept = fromPerHost(view, old);
    return {
      active: old === core ? kept.active : into.active,
      focused: { ...into.focused, ...kept.focused },
      zoomed: { ...into.zoomed, ...kept.zoomed },
      spaces: { ...into.spaces, ...kept.spaces },
      seen: { ...into.seen, ...kept.seen },
    };
  }, NO_VIEW);
  return viewOn(merged, core);
}

/** Drops the per-host views once the device's one view is saved; a storage that refuses leaves them, unread. */
export function dropPerHostViews(
  oldCores: readonly string[] = perHostViews(),
  storage: Pick<Storage, "removeItem"> = browserStorage("localStorage"),
): void {
  try {
    for (const old of oldCores) storage.removeItem(perHostKey(old));
  } catch {
    // Left behind, they are never read again: the one view is what loads.
  }
}

/**
 * Saves this screen's view; null once it is saved, else why the storage refused it (full or denied). A refusal never
 * throws: the view lives on in memory, and only the next reload loses the selection and focus.
 */
export function saveView(
  core: string,
  view: View,
  storage: Pick<Storage, "setItem"> = browserStorage("localStorage"),
): string | null {
  try {
    storage.setItem(VIEW_KEY, JSON.stringify(storedView(view, core)));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** A tab's key: its id in the document, behind its machine's permanent id when it is not this core's. */
export const tabKey = (machineId: string | null, tabId: string): string =>
  machineId === null ? tabId : `${machineId}/${tabId}`;

/** A space's key: its id in the document, behind its machine's permanent id when it is not this core's, as tabKey. */
export const spaceKey = (machineId: string | null, spaceId: string): string => `space:${tabKey(machineId, spaceId)}`;

/**
 * The view with the finishes this screen has shown noted (#611); a finish already noted is not written again, so a screen
 * that has already looked at an agent does not change and save its view on every render.
 */
export function rememberSeen(view: View, marks: Seen): View {
  const added = Object.entries(marks).filter(([address, mark]) => view.seen[address] !== mark);
  return added.length === 0 ? view : { ...view, seen: { ...view.seen, ...Object.fromEntries(added) } };
}
