import {
  childrenOf,
  editTab,
  equalize,
  freshId,
  movePane,
  nodeAt,
  pathTo,
  resizeAt,
  swapPanes,
  type Edge,
  type Node,
} from "@doriface/protocol/layout";
import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import { paneMove, type Direction } from "../layout/neighbor.ts";
import { arrange } from "../layout/rects.ts";
import type { View } from "../layout/view.ts";
import type { LayoutPane, LayoutTab } from "./layout-model.ts";
import type { MachineLayout } from "./use-layout-docs.ts";

export interface Bump {
  readonly pane: string;
  readonly direction: Direction;
  readonly seq: number;
}

/** What moves focus between panes and changes their sizes and zoom in the tab in view. */
export interface PaneMoves {
  /**
   * Focuses the nearest pane that way in the tab in view. With no pane that way in a split tab it nudges the focused
   * pane (`bumped`) and leaves the key to its program too, as a lone pane does.
   */
  readonly go: (direction: Direction) => boolean;
  readonly bumped: Bump | null;
  /**
   * Moves the line between children `index` and `index + 1` of a row or column of the tab in view by `delta`; true once
   * the write landed, false when nothing was written.
   */
  readonly resize: (container: string, index: number, delta: number) => Promise<boolean>;
  /** Moves the focused pane's nearest edge that way by one step, as Ghostty's `resize_split`. */
  readonly resizeFocused: (direction: Direction) => boolean;
  readonly equalize: () => boolean;
  readonly toggleZoom: () => boolean;
  /**
   * Moves pane `source` of the tab in view beside pane `target` on `edge`, or swaps the two (`swap`), as herdr-app's
   * pane drag, and focuses it; true once the write landed, false when nothing was written.
   */
  readonly move: (source: string, target: string, edge: Edge | "swap") => Promise<boolean>;
  /** Swaps the focused pane with its nearest neighbour that way, as herdr-app's `pane.swap`; focus stays with it. */
  readonly swap: (direction: Direction) => boolean;
}

export interface PaneMovesContext {
  readonly active: LayoutTab | null;
  readonly focused: LayoutPane | null;
  readonly layoutOf: (machine: string | null) => MachineLayout | undefined;
  readonly show: (key: string, pane: string | null) => void;
  readonly setView: Dispatch<SetStateAction<View>>;
  readonly history: ReadonlyMap<string, readonly string[]>;
}

/** Proportions are all moving focus needs, so it measures the tree in a fixed box with the panes' gap. */
const MEASURE = { x: 0, y: 0, width: 1600, height: 1000 } as const;
/** A keyboard resize step: a twentieth of the row or column, about Ghostty's ten cells on a laptop screen. */
export const RESIZE_STEP = 0.05;

export function usePaneMoves({ active, focused, layoutOf, show, setView, history }: PaneMovesContext): PaneMoves {
  const [bumped, setBumped] = useState<Bump | null>(null);
  const go = useCallback(
    (direction: Direction): boolean => {
      if (active === null || focused === null) return false;
      const { panes } = arrange(active.root, MEASURE, 8, null);
      const move = paneMove(focused.id, direction, panes, history.get(active.key) ?? []);
      if (move.kind === "pass") return false;
      if (move.kind === "bump") {
        setBumped((prev) => ({ pane: focused.id, direction, seq: (prev?.seq ?? 0) + 1 }));
        // The nudge says there is no pane that way; it does not take the key from the program (#1302, #1172).
        return false;
      }
      show(active.key, move.to);
      return true;
    },
    [active, focused, show],
  );

  // Pane sizes and places are shared in the herdr-app document, as herdr-app keeps them; this is the one place that
  // writes them, so keeping them per device instead would change only this function.
  // The write, or null when the tab in view takes no edits.
  const editSizes = useCallback(
    (change: (root: Node) => Node | null): Promise<boolean> | null => {
      if (active === null || active.transient) return null;
      const layout = layoutOf(active.machine);
      if (layout === undefined || layout.readOnly !== null) return null;
      const id = active.id;
      return layout.edit((doc) => (doc === null ? null : editTab(doc, id, change)));
    },
    [active, layoutOf],
  );

  const resize = useCallback(
    (container: string, index: number, delta: number): Promise<boolean> =>
      editSizes((root) => resizeAt(root, container, index, delta)) ?? Promise.resolve(false),
    [editSizes],
  );

  const resizeFocused = useCallback(
    (direction: Direction): boolean => {
      if (active === null || focused === null) return false;
      const edge = nearestEdge(active.root, focused.id, direction);
      return edge !== null && editSizes((root) => resizeAt(root, edge.container, edge.index, edge.delta)) !== null;
    },
    [active, editSizes, focused],
  );

  const equalizeTab = useCallback((): boolean => editSizes(equalize) !== null, [editSizes]);

  const toggleZoom = useCallback((): boolean => {
    if (active === null || focused === null || active.panes.length < 2) return false;
    const key = active.key;
    const pane = focused.id;
    setView((prev) => {
      const { [key]: was, ...others } = prev.zoomed;
      return { ...prev, zoomed: was === pane ? others : { ...others, [key]: pane } };
    });
    return true;
  }, [active, focused]);

  const move = useCallback(
    (source: string, target: string, edge: Edge | "swap"): Promise<boolean> => {
      if (active === null) return Promise.resolve(false);
      const key = active.key;
      const written = editSizes((root) =>
        edge === "swap" ? swapPanes(root, source, target) : movePane(root, source, target, edge, freshId("s")),
      );
      if (written === null) return Promise.resolve(false);
      show(key, source);
      return written;
    },
    [active, editSizes, show],
  );

  // herdr-app's swap goes by geometry only: the nearest pane that way, not the one last visited. With none there it
  // leaves the key to the program, as moving focus does.
  const swap = useCallback(
    (direction: Direction): boolean => {
      if (active === null || focused === null) return false;
      const { panes } = arrange(active.root, MEASURE, 8, null);
      const next = paneMove(focused.id, direction, panes, []);
      if (next.kind !== "go") return false;
      editSizes((root) => swapPanes(root, focused.id, next.to));
      return true;
    },
    [active, editSizes, focused],
  );

  return { go, bumped, resize, resizeFocused, equalize: equalizeTab, toggleZoom, move, swap };
}

/** The line Ghostty's `resize_split` moves: in the nearest row (left, right) or column (up, down) around the pane. */
function nearestEdge(
  root: Node,
  pane: string,
  direction: Direction,
): { readonly container: string; readonly index: number; readonly delta: number } | null {
  const path = pathTo(root, pane);
  if (path === null) return null;
  const axis = direction === "left" || direction === "right" ? "row" : "column";
  const forward = direction === "right" || direction === "down";
  for (let depth = path.length - 1; depth >= 0; depth -= 1) {
    const container = nodeAt(root, path.slice(0, depth));
    const at = path[depth];
    if (container === null || at === undefined || container["type"] !== axis) continue;
    const count = childrenOf(container).length;
    if (count < 2) continue;
    const index = at < count - 1 ? at : at - 1;
    return { container: String(container["id"]), index, delta: forward ? RESIZE_STEP : -RESIZE_STEP };
  }
  return null;
}
