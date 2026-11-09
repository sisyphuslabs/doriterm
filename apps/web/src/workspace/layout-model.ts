import type { JsonObject, Terminal } from "@doriface/protocol";
import { addTab, docSpaces, freshId, type Node, panesOf, tabsOf, terminalBlock } from "@doriface/protocol/layout";
import { spaceKey, tabKey, type View } from "../layout/view.ts";
import { machineOf, SPACE_LABEL } from "./model.ts";
import { type MachineIds, tabKey as terminalKey } from "./tab-keys.ts";
import type { MachineLayout } from "./use-layout-docs.ts";

export interface LayoutPane {
  readonly id: string;
  /** The terminal's address as this core names it (`build-box/t3`), or null for a herdr-app panel. */
  readonly address: string | null;
  readonly mod: string | null;
  /** The id its view is mounted under, when that is not `id` (see `keepMounts`). */
  readonly mount?: string;
}

export interface LayoutTab {
  readonly key: string;
  readonly id: string;
  readonly space: string;
  /** The space it belongs to across machines (`spaceKey`); a tab of no document is a space of its own. */
  readonly spaceKey: string;
  readonly machine: string | null;
  readonly name: string;
  readonly root: Node;
  /** Pinned in front of its space's other tabs (#1561). */
  readonly pinned: boolean;
  readonly panes: readonly LayoutPane[];
  readonly readOnly: string | null;
  /** Not in any document (the first live terminal shown alone, or a loose tab); written once it is split. */
  readonly transient: boolean;
  /** The key its panel is mounted under, when that is not `key` (see `keepMounts`). */
  readonly mount?: string;
}

/** Where a view is mounted: its tab's panel key and its pane's key. */
export interface Mount {
  readonly tab: string;
  readonly pane: string;
}

/** What keepMounts remembers from one render to the next. */
export interface Mounts {
  /** Terminals shown in a tab of no document (transient or loose), by address: where their views are mounted. */
  readonly shown: Map<string, Mount>;
  /**
   * Per document tab, decided when it first shows and kept for good (a tab's id is never reused): the view it took over
   * (its pane id and that mount), or none. A tab that drops out of a render and comes back keeps its decision.
   */
  readonly taken: Map<string, { readonly pane: string; readonly mount: Mount } | null>;
}

export const newMounts = (): Mounts => ({ shown: new Map(), taken: new Map() });

/**
 * A document tab that takes over a terminal this screen showed in a tab of no document (the first live terminal shown
 * alone while its tab was still being written, or a loose tab) keeps that tab's panel and pane keys, so the terminal's
 * view is not mounted again: a remount drops the keys typed into it meanwhile (#381). Decided when the document tab
 * first shows and kept while it lives; nothing else changes, since tabs and panes are still named by `key` and `id`.
 */
export function keepMounts(tabs: readonly LayoutTab[], mounts: Mounts): LayoutTab[] {
  const inUse = new Set(tabs.flatMap((tab) => (tab.transient ? [tab.key] : [])));
  for (const taken of mounts.taken.values()) if (taken !== null) inUse.add(taken.mount.tab);
  const kept = tabs.map((tab): LayoutTab => {
    if (tab.transient) {
      const pane = tab.panes[0];
      if (pane?.address != null) mounts.shown.set(pane.address, { tab: tab.key, pane: pane.id });
      return tab;
    }
    if (!mounts.taken.has(tab.key)) {
      const pane = tab.panes.find((each) => each.address !== null && mounts.shown.has(each.address));
      const mount = pane?.address == null ? undefined : mounts.shown.get(pane.address);
      const free = mount !== undefined && !inUse.has(mount.tab);
      mounts.taken.set(tab.key, pane !== undefined && mount !== undefined && free ? { pane: pane.id, mount } : null);
      if (pane?.address != null && free) {
        mounts.shown.delete(pane.address);
        inUse.add(mount.tab);
      }
    }
    const taken = mounts.taken.get(tab.key);
    if (taken === null || taken === undefined) return tab;
    const panes = tab.panes.map((pane) => (pane.id === taken.pane ? { ...pane, mount: taken.mount.pane } : pane));
    return { ...tab, mount: taken.mount.tab, panes };
  });
  return kept;
}

export const TRANSIENT = "transient";
const LOOSE = "loose:";
/** hc's permanent machine ids by the names the layouts give the machines now, both ways. */
export function layoutIds(layouts: readonly MachineLayout[]): MachineIds {
  const named = layouts.flatMap((layout) =>
    layout.machine === null || layout.machineId === null ? [] : [[layout.machine, layout.machineId] as const],
  );
  return { byName: new Map(named), byId: new Map(named.map(([name, id]) => [id, name])) };
}

/** A loose tab's key, from what its terminal is remembered by (tab-keys.ts): a machine rename keeps it (#459). */
export const looseKey = (address: string, ids: MachineIds): string => `${LOOSE}${terminalKey(address, ids)}`;

export const qualify = (local: string, machine: string | null): string =>
  machine === null ? local : `${machine}/${local}`;

export function localOf(address: string): string {
  const slash = address.indexOf("/");
  return slash === -1 ? address : address.slice(slash + 1);
}

function docTabs(layout: MachineLayout): LayoutTab[] {
  if (layout.doc === null) return [];
  return tabsOf(layout.doc, layout.pins).map((tab) => ({
    key: tabKey(layout.machineId, tab.id),
    id: tab.id,
    space: tab.space,
    spaceKey: spaceKey(layout.machineId, tab.space),
    machine: layout.machine,
    name: tab.name,
    root: tab.root,
    pinned: tab.pinned,
    panes: panesOf(tab.root).map((pane) => ({
      id: pane.id,
      address: pane.terminal === null ? null : qualify(pane.terminal, layout.machine),
      mod: pane.mod,
    })),
    readOnly: layout.readOnly,
    transient: false,
  }));
}

function looseTab(address: string, layouts: readonly MachineLayout[], ids: MachineIds): LayoutTab {
  const machine = machineOf(address) ?? null;
  const owner = layouts.find((layout) => layout.machine === machine);
  return {
    key: looseKey(address, ids),
    id: looseKey(address, ids),
    space: "",
    spaceKey: looseKey(address, ids),
    machine,
    name: "",
    root: { children: [terminalBlock(TRANSIENT, localOf(address))], id: "", type: "row" },
    pinned: false,
    panes: [{ id: TRANSIENT, address, mod: null }],
    readOnly: owner?.readOnly ?? "the machine is not connected",
    transient: true,
  };
}

/**
 * Every tab of every machine's document, this core's first, then the terminals opened on this screen while their
 * machine's layout could not take a tab (`loose`: offline, loading). With no tab at all, the first live terminal is
 * shown alone, as it opened before the layout lived in the core, but only while this core has no layout yet: a layout
 * whose tabs were all closed shows none while a terminal runs on outside any tab (started outside the app, or kept by an
 * older build's Keep running), so the workspace is empty and the terminal waits in the sidebar (#354).
 */
export function buildTabs(
  layouts: readonly MachineLayout[],
  terminals: readonly Terminal[],
  loose: readonly string[] = [],
): LayoutTab[] {
  const tabs = layouts.flatMap(docTabs);
  const shown = new Set(tabs.flatMap((tab) => tab.panes.map((pane) => pane.address)));
  const ids = layoutIds(layouts);
  const extra = loose.filter((address) => !shown.has(address)).map((address) => looseTab(address, layouts, ids));
  if (tabs.length + extra.length > 0) return [...tabs, ...extra];
  const local = layouts.find((layout) => layout.machine === null);
  const first = terminals.find((terminal) => terminal.state === "live");
  if (local === undefined || !local.loaded || local.doc !== null || first === undefined) return [];
  return [{ ...looseTab(first.address, layouts, ids), key: TRANSIENT, id: TRANSIENT, spaceKey: TRANSIENT }];
}

/**
 * The tabs the tab bar shows: those of the space the tab in view belongs to, in their document's order, as herdr-app's
 * strip shows the selected space's tabs (#404). With no tab in view, the first tab's space.
 */
export function spaceTabs(tabs: readonly LayoutTab[], active: LayoutTab | null): LayoutTab[] {
  const space = (active ?? tabs[0])?.spaceKey;
  return space === undefined ? [] : tabs.filter((tab) => tab.spaceKey === space);
}

export interface Picked {
  readonly active: LayoutTab | null;
  readonly focused: LayoutPane | null;
  readonly zoomed: string | null;
}

/**
 * The selected tab and its focused pane: what the view remembers when it is still there, else the document tab that took
 * over its view (a loose or lone tab whose terminal a document now holds, as an adoption writes it: keepMounts), else
 * the first. Without the take-over a loose tab adopted into its machine's layout would lose the selection to the first
 * tab while its terminal's view lived on, hidden (#495).
 */
export function pick(tabs: readonly LayoutTab[], view: View): Picked {
  const active =
    tabs.find((tab) => tab.key === view.active) ?? tabs.find((tab) => tab.mount === view.active) ?? tabs[0] ?? null;
  if (active === null) return { active, focused: null, zoomed: null };
  const remembered = view.focused[active.key];
  const focused = active.panes.find((pane) => pane.id === remembered) ?? active.panes[0] ?? null;
  const zoomed = view.zoomed[active.key];
  return { active, focused, zoomed: active.panes.some((pane) => pane.id === zoomed) ? (zoomed ?? null) : null };
}

/**
 * What a new tab for `address` does with the tab in view when no document holds that tab (`transient`). One of the new
 * tab's machine goes beside it in the same write (`with-new`) when that layout takes edits. The first live terminal
 * shown alone goes to its own machine's layout (`apart`) otherwise, as buildTabs stops showing it once any document
 * holds a tab; a loose tab stays as it is.
 */
export function keepTransient(
  active: LayoutTab | null,
  address: string,
  writable: boolean,
): "with-new" | "apart" | null {
  if (active === null || !active.transient || active.panes[0]?.address === address) return null;
  if (writable && active.machine === (machineOf(address) ?? null)) return "with-new";
  return active.key === TRANSIENT ? "apart" : null;
}

/**
 * The tab shown once this screen closes `closed`, the tab in view, as herdr-app's `remove_tab` picks it: the tab that
 * slides into its place in its space, else that space's last. A space left with no tab goes (`remove_space`): the space
 * that slides into its place, else the last one, is shown on the tab it showed last (`remembered`), else its first.
 * Null when no other tab is open.
 */
export function afterClosing(
  tabs: readonly LayoutTab[],
  closed: string,
  remembered: Readonly<Record<string, string>> = {},
): string | null {
  const at = tabs.findIndex((tab) => tab.key === closed);
  const space = tabs[at]?.spaceKey;
  const others = tabs.filter((tab) => tab.key !== closed);
  const same = tabs.filter((tab) => tab.spaceKey === space);
  const slot = same.findIndex((tab) => tab.key === closed);
  const kept = same.filter((tab) => tab.key !== closed);
  const inSpace = kept[slot] ?? kept.at(-1);
  if (inSpace !== undefined) return inSpace.key;
  const order = [...new Set(tabs.map((tab) => tab.spaceKey))];
  const left = order.filter((key) => key !== space);
  const next = order.slice(order.indexOf(space ?? "") + 1).find((key) => key !== space) ?? left.at(-1);
  if (next === undefined) return null;
  const shown = others.filter((tab) => tab.spaceKey === next);
  return (shown.find((tab) => tab.key === remembered[next]) ?? shown[0])?.key ?? null;
}

export function findTerminal(tabs: readonly LayoutTab[], address: string): { tab: LayoutTab; pane: LayoutPane } | null {
  for (const tab of tabs) {
    const pane = tab.panes.find((each) => each.address === address);
    if (pane !== undefined) return { tab, pane };
  }
  return null;
}

/** Whether a space's folder holds the directory: the folder itself, or one inside it. */
const holds = (folder: string, dir: string): boolean =>
  folder !== "" && (dir === folder || dir.startsWith(folder.endsWith("/") ? folder : `${folder}/`));

/** Addresses by their numbers (`t9` before `t10`), for terminals started in the same millisecond. */
const BY_ADDRESS = new Intl.Collator("en", { numeric: true });

/** The space adopted terminals with no space of their own go to, as herdr-app names its fallback. */
export const HOME_SPACE = "Home";

/**
 * The document with every live terminal of its machine that no tab shows adopted as a tab of its own (#404): in the space
 * its `space` label names (made when there is none, as that label named its space before #404), else in the space
 * whose folder holds its working directory (the deepest such folder), else in the machine's Home space, made when there
 * is none. A terminal another one started (`parent`) is not a tab of its own. Tabs are added in the order the terminals
 * started, not the feed's: hc lists them by address as text, so `t10` came before `t9` (#1269). Null when every terminal
 * has a tab, so nothing is written; read inside the document's edit, so a reload or a second device adopts nothing twice.
 */
export function adoptLoose(
  doc: JsonObject | null,
  terminals: readonly Terminal[],
  makeId: (prefix: "tb" | "p" | "spc") => string = freshId,
): JsonObject | null {
  const shown = new Set(
    doc === null
      ? []
      : tabsOf(doc).flatMap((tab) =>
          panesOf(tab.root).flatMap((pane) => (pane.terminal === null ? [] : [pane.terminal])),
        ),
  );
  const loose = terminals
    .filter(
      (terminal) =>
        terminal.state === "live" && (terminal.parent ?? null) === null && !shown.has(localOf(terminal.address)),
    )
    .toSorted((a, b) => a.created_ms - b.created_ms || BY_ADDRESS.compare(a.address, b.address));
  if (loose.length === 0) return null;
  const spaces = doc === null ? [] : docSpaces(doc);
  let home = spaces.find((space) => space.name === HOME_SPACE && space.folder === "")?.id;
  let next = doc;
  for (const terminal of loose) {
    const dir = terminal.foreground?.cwd ?? terminal.cwd;
    const owner = spaces
      .filter((space) => holds(space.folder, dir))
      .toSorted((a, b) => b.folder.length - a.folder.length)[0];
    const id = makeId("tb");
    const tab: JsonObject = {
      id,
      name: "",
      root: { children: [terminalBlock(makeId("p"), localOf(terminal.address))], id, type: "row" },
    };
    const label = terminal.labels[SPACE_LABEL] ?? "";
    if (label !== "") {
      const named = next === null ? undefined : docSpaces(next).find((space) => space.name === label);
      next = addTab(next, { id: named?.id ?? makeId("spc"), folder: named?.folder ?? "", name: label }, tab);
    } else if (owner !== undefined) {
      next = addTab(next, { id: owner.id, folder: owner.folder }, tab);
    } else {
      home ??= makeId("spc");
      next = addTab(next, { id: home, folder: "", name: HOME_SPACE }, tab);
    }
  }
  return next;
}
