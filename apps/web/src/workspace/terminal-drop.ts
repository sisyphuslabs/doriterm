import type { JsonObject } from "@doriface/protocol";
import {
  addTab,
  editTab,
  isContainer,
  movePane,
  nodeAt,
  paneNode,
  panesOf,
  pathTo,
  placeBeside,
  removePane,
  removeTab,
  replaceAt,
  replacePane,
  swapPanes,
  tabsOf,
  terminalBlock,
  withoutField,
  type Axis,
  type Edge,
  type Node,
} from "@doriface/protocol/layout";
import type { Zone } from "../layout/drop-zone.ts";
import { shownIn } from "./adoption.ts";

/** A terminal dropped on pane `target` of tab `tab`, in the zone the drop was in. */
export interface TerminalDrop {
  readonly tab: string;
  readonly target: string;
  readonly zone: Zone;
}

/** The ids a drop may need: the pane a terminal shown by no pane gets, and the container a split may need. */
export interface FreshIds {
  readonly pane: string;
  readonly container: string;
}

/** What to save, and the pane that shows the dropped terminal once it is saved. */
export interface TerminalDropWrite {
  readonly doc: JsonObject;
  readonly pane: string;
}

const rootOf = (doc: JsonObject, tab: string) => tabsOf(doc).find((each) => each.id === tab)?.root;

function paneIn(doc: JsonObject, tab: string, pane: string): Node | null {
  const root = rootOf(doc, tab);
  return root === undefined ? null : paneNode(root, pane);
}

/** The document without pane `pane` of tab `tab`, and without the tab when that was its only pane. */
function withoutPane(doc: JsonObject, tab: string, pane: string): JsonObject | null {
  const root = rootOf(doc, tab);
  if (root === undefined) return null;
  return panesOf(root).length === 1 ? removeTab(doc, tab) : editTab(doc, tab, (each) => removePane(each, pane));
}

/**
 * The write that makes `terminal` (as its machine's document names it) a pane of `drop.tab`, as herdr-app's pane drag
 * places a pane: beside the target on an edge, or in its place in the middle. A terminal already in a pane of that tab
 * moves as a dragged pane does; one in another tab leaves it (the tab goes with its last pane) and, in the middle, trades
 * places with the target; one no pane shows yet gets a new pane, and in the middle the target's terminal leaves the tab
 * still running, to be given a tab of its own as any terminal no pane shows. Every pane keeps its id, so no terminal
 * restarts. Null when there is nothing to write: the target is gone, or it already shows the terminal.
 */
export function terminalDropWrite(
  doc: JsonObject | null,
  terminal: string,
  drop: TerminalDrop,
  fresh: FreshIds,
): TerminalDropWrite | null {
  if (doc === null) return null;
  const { tab, target, zone } = drop;
  const targetNode = paneIn(doc, tab, target);
  if (targetNode === null) return null;
  const from = shownIn(doc, terminal);
  if (from?.pane === target) return null;
  if (from !== null && from.tab === tab) {
    const moved = editTab(doc, tab, (root) =>
      zone === "swap" ? swapPanes(root, from.pane, target) : movePane(root, from.pane, target, zone, fresh.container),
    );
    return moved === null ? null : { doc: moved, pane: from.pane };
  }
  if (from === null) {
    const block = terminalBlock(fresh.pane, terminal);
    const placed = editTab(doc, tab, (root) =>
      zone === "swap" ? replacePane(root, target, block) : placeBeside(root, target, zone, block, fresh.container),
    );
    return placed === null ? null : { doc: placed, pane: fresh.pane };
  }
  const moving = paneIn(doc, from.tab, from.pane);
  if (moving === null) return null;
  if (zone === "swap") {
    const here = editTab(doc, tab, (root) => replacePane(root, target, moving));
    const there = here === null ? null : editTab(here, from.tab, (root) => replacePane(root, from.pane, targetNode));
    return there === null ? null : { doc: there, pane: from.pane };
  }
  const left = withoutPane(doc, from.tab, from.pane);
  const placed =
    left === null ? null : editTab(left, tab, (root) => placeBeside(root, target, zone, moving, fresh.container));
  return placed === null ? null : { doc: placed, pane: from.pane };
}

/**
 * Places any layout node (a single pane or a multi-pane subtree) beside `target` along `edge`.
 * Single-pane blocks delegate to `placeBeside` (which merges into an existing same-axis parent);
 * container subtrees wrap `target` and the incoming subtree in a fresh container so all 4 edges work cleanly.
 */
function placeSubtreeBeside(root: Node, target: string, edge: Edge, incoming: Node, containerId: string): Node | null {
  if (!isContainer(incoming)) return placeBeside(root, target, edge, incoming, containerId);
  const path = pathTo(root, target);
  if (path === null) return null;
  const old = nodeAt(root, path);
  if (old === null || isContainer(old)) return null;
  const axis: Axis = edge === "left" || edge === "right" ? "row" : "column";
  const slot = old["size"];
  const cleanOld = withoutField(old, "size");
  const cleanIncoming = withoutField(incoming, "size");
  const children = edge === "left" || edge === "top" ? [cleanIncoming, cleanOld] : [cleanOld, cleanIncoming];
  const wrapper: Node = {
    children,
    id: containerId,
    ...(slot === undefined ? {} : { size: slot }),
    type: axis,
  };
  return replaceAt(root, path, () => wrapper);
}

/**
 * The write that docks another tab (`sourceTab`) onto pane `drop.target` of `drop.tab`:
 * - On an edge (`left` / `right` / `top` / `bottom`): removes `sourceTab` and splits `drop.target` with `sourceTab`'s
 *   pane (or full pane subtree if `sourceTab` was already split).
 * - In the center (`swap`): trades places between `drop.target` and `sourceTab`'s pane (or subtree).
 * Every leaf pane keeps its id so no terminal restarts.
 */
export function tabDropWrite(
  doc: JsonObject | null,
  sourceTab: string,
  drop: TerminalDrop,
  containerId: string,
): TerminalDropWrite | null {
  if (doc === null) return null;
  const { tab: targetTab, target, zone } = drop;
  if (sourceTab === targetTab) return null;
  const sourceRoot = rootOf(doc, sourceTab);
  const targetNode = paneIn(doc, targetTab, target);
  if (sourceRoot === undefined || targetNode === null) return null;
  const sourcePanes = panesOf(sourceRoot);
  const lead = sourcePanes[0];
  if (lead === undefined) return null;

  if (sourcePanes.length === 1) {
    const moving = paneIn(doc, sourceTab, lead.id);
    if (moving === null) return null;
    if (zone === "swap") {
      const here = editTab(doc, targetTab, (root) => replacePane(root, target, moving));
      const there = here === null ? null : editTab(here, sourceTab, (root) => replacePane(root, lead.id, targetNode));
      return there === null ? null : { doc: there, pane: lead.id };
    }
    const without = removeTab(doc, sourceTab);
    const placed =
      without === null
        ? null
        : editTab(without, targetTab, (root) => placeBeside(root, target, zone, moving, containerId));
    return placed === null ? null : { doc: placed, pane: lead.id };
  }

  const movingSubtree = withoutField(sourceRoot, "size");
  if (zone === "swap") {
    const here = editTab(doc, targetTab, (root) => replacePane(root, target, movingSubtree));
    const there = here === null ? null : editTab(here, sourceTab, () => withoutField(targetNode, "size"));
    return there === null ? null : { doc: there, pane: lead.id };
  }
  const without = removeTab(doc, sourceTab);
  const placed =
    without === null
      ? null
      : editTab(without, targetTab, (root) => placeSubtreeBeside(root, target, zone, movingSubtree, containerId));
  return placed === null ? null : { doc: placed, pane: lead.id };
}

/** What to save when popping a pane out of a split tab into a fresh tab beside it. */
export interface DetachPaneWrite {
  readonly doc: JsonObject;
  readonly tab: string;
  readonly pane: string;
}

/**
 * Extracts `pane` from split tab `tab` and places it into a new tab right after `tab` in the same space.
 * The pane keeps its exact id so its live terminal/agent never restarts. Null when `tab` has only one pane.
 */
export function detachPaneWrite(
  doc: JsonObject | null,
  tab: string,
  pane: string,
  newTabId: string,
): DetachPaneWrite | null {
  if (doc === null) return null;
  const source = tabsOf(doc).find((each) => each.id === tab);
  if (source === undefined || panesOf(source.root).length < 2) return null;
  const moving = paneNode(source.root, pane);
  if (moving === null) return null;
  const without = editTab(doc, tab, (root) => removePane(root, pane));
  if (without === null) return null;
  const freshTab: JsonObject = { id: newTabId, name: "", root: withoutField(moving, "size") };
  const next = addTab(without, { id: source.space, folder: "" }, freshTab, tab);
  return { doc: next, tab: newTabId, pane };
}
