import type { JsonObject } from "@doriface/protocol";
import {
  editTab,
  movePane,
  paneNode,
  panesOf,
  placeBeside,
  removePane,
  removeTab,
  replacePane,
  swapPanes,
  tabsOf,
  terminalBlock,
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
