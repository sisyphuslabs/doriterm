import { useSyncExternalStore } from "react";
import { childrenOf, idOf, typeOf, type Node } from "@doriface/protocol/layout";
import { arrange, type Arrangement, type Rect } from "./rects.ts";

/**
 * The gap between a dual-screen or folded device's two viewport segments (CSS Viewport Segments, `window.viewport`),
 * in the coordinates of `box` (a page rectangle); null with one segment, or when the gap does not cross the box.
 */
export function hingeIn(segments: readonly Rect[], box: Rect): Rect | null {
  const [first, second] = segments;
  if (segments.length !== 2 || first === undefined || second === undefined) return null;
  const beside = second.x >= first.x + first.width;
  const gap = beside
    ? { x: first.x + first.width, y: box.y, width: second.x - first.x - first.width, height: box.height }
    : { x: box.x, y: first.y + first.height, width: box.width, height: second.y - first.y - first.height };
  const inside = beside
    ? gap.x > box.x && gap.x + gap.width < box.x + box.width
    : gap.y > box.y && gap.y + gap.height < box.y + box.height;
  return inside ? { ...gap, x: gap.x - box.x, y: gap.y - box.y } : null;
}

const shown = (node: Node): boolean => node["hidden"] !== true;

/**
 * `arrange`, except that a two-pane split along the hinge puts its line on it: each side of the fold holds one pane (or
 * one subtree), and that line is the device's own, so it has no divider to drag.
 */
export function arrangeOnHinge(
  root: Node,
  box: Rect,
  gap: number,
  zoomed: string | null,
  hinge: Rect | null,
): Arrangement {
  const plain = arrange(root, box, gap, zoomed);
  if (hinge === null || zoomed !== null) return plain;
  const children = childrenOf(root).filter(shown);
  const [before, after] = children;
  const vertical = hinge.height >= hinge.width;
  if (children.length !== 2 || before === undefined || after === undefined) return plain;
  if (typeOf(root) !== (vertical ? "row" : "column")) return plain;
  const { x, y, width, height } = box;
  const [one, two]: readonly [Rect, Rect] = vertical
    ? [
        { x, y, width: hinge.x - x, height },
        { x: hinge.x + hinge.width, y, width: x + width - hinge.x - hinge.width, height },
      ]
    : [
        { x, y, width, height: hinge.y - y },
        { x, y: hinge.y + hinge.height, width, height: y + height - hinge.y - hinge.height },
      ];
  const [left, right] = [arrange(before, one, gap, null), arrange(after, two, gap, null)];
  return {
    panes: new Map([...left.panes, ...right.panes]),
    dividers: [...left.dividers, ...right.dividers],
    containers: new Map([[idOf(root), box], ...left.containers, ...right.containers]),
  };
}

interface ViewportSegments {
  readonly segments?: readonly DOMRect[] | null;
}

const viewportOf = (): ViewportSegments | undefined => Reflect.get(window, "viewport") as ViewportSegments | undefined;

let lastKey = "";
let last: readonly Rect[] = [];

/** The window's viewport segments, the same array while they stay the same (one entry on a flat screen). */
function readSegments(): readonly Rect[] {
  const segments = viewportOf()?.segments ?? [];
  const key = segments.map((each) => `${each.x},${each.y},${each.width},${each.height}`).join(" ");
  if (key !== lastKey) {
    lastKey = key;
    last = segments.map((segment) => ({ x: segment.x, y: segment.y, width: segment.width, height: segment.height }));
  }
  return last;
}

function subscribe(listener: () => void): () => void {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}

/** The viewport segments, following a fold, an unfold and a rotation (each resizes the window). */
export function useViewportSegments(): readonly Rect[] {
  return useSyncExternalStore(subscribe, readSegments);
}
