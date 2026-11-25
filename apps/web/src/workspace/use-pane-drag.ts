import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { dropZone, type Zone } from "../layout/drop-zone.ts";
import type { Rect } from "../layout/rects.ts";

/** Pointer travel before a press on a pane's header becomes a drag (herdr-app's 4 px); less is still a click. */
export const PANE_DRAG_THRESHOLD_PX = 4;

export interface PaneDropTarget {
  readonly pane: string;
  readonly zone: Zone;
}

/** A pane being dragged in a tab, and where it would land now (none while over no other pane). */
export interface PaneDragState {
  readonly tab: string;
  readonly pane: string;
  readonly target: PaneDropTarget | null;
}

export interface PaneDrag {
  readonly drag: PaneDragState | null;
  /** The pointerdown handler for a pane's header: it starts a drag of that pane, never from one of its buttons. */
  readonly grab: (tab: string, pane: string) => (event: ReactPointerEvent<HTMLElement>) => void;
}

/** The pane other than `dragged` under (x, y) of `box`, with the zone the point is in; none over no other pane. */
export function targetIn(
  box: HTMLElement | null,
  panes: ReadonlyMap<string, Rect> | undefined,
  dragged: string,
  x: number,
  y: number,
): PaneDropTarget | null {
  if (box === null || panes === undefined) return null;
  const origin = box.getBoundingClientRect();
  for (const [id, rect] of panes) {
    if (id === dragged) continue;
    const zone = dropZone(rect, x - origin.left, y - origin.top);
    if (zone !== null) return { pane: id, zone };
  }
  return null;
}

/**
 * herdr-app's pane drag: a press on a pane's header that travels past the threshold drags the pane, the other panes'
 * drop zones follow the pointer, a release over one drops it there, and Escape, a release over no pane, a lost pointer
 * or a lost window cancels. `rects` gives each tab's panes in the coordinates of `box`; `onDrop` writes the move.
 */
export function usePaneDrag(
  box: RefObject<HTMLElement | null>,
  rects: (tab: string) => ReadonlyMap<string, Rect> | undefined,
  onDrop: (tab: string, pane: string, target: PaneDropTarget) => void,
): PaneDrag {
  const [drag, setDrag] = useState<PaneDragState | null>(null);
  const latest = useRef({ rects, onDrop });
  latest.current = { rects, onDrop };
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const grab = useCallback(
    (tab: string, pane: string) =>
      (event: ReactPointerEvent<HTMLElement>): void => {
        if (event.button !== 0 || !event.isPrimary) return;
        if (event.target instanceof Element && event.target.closest("button") !== null) return;
        // No text selection and no focus move start from the header: the press is the drag's.
        event.preventDefault();
        stop.current?.();
        const { pointerId, clientX: startX, clientY: startY } = event;
        let moving = false;
        const move = (moved: PointerEvent): void => {
          if (moved.pointerId !== pointerId) return;
          const travel = Math.max(Math.abs(moved.clientX - startX), Math.abs(moved.clientY - startY));
          if (!moving && travel < PANE_DRAG_THRESHOLD_PX) return;
          moving = true;
          setDrag({
            tab,
            pane,
            target: targetIn(box.current, latest.current.rects(tab), pane, moved.clientX, moved.clientY),
          });
        };
        const release = (up: PointerEvent): void => {
          if (up.pointerId !== pointerId) return;
          const target = moving ? targetIn(box.current, latest.current.rects(tab), pane, up.clientX, up.clientY) : null;
          end();
          if (target !== null) latest.current.onDrop(tab, pane, target);
        };
        const key = (down: KeyboardEvent): void => {
          if (down.key !== "Escape") return;
          down.preventDefault();
          down.stopImmediatePropagation();
          end();
        };
        const cancel = (): void => end();
        function end(): void {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", release);
          window.removeEventListener("pointercancel", cancel);
          window.removeEventListener("keydown", key, true);
          window.removeEventListener("blur", cancel);
          stop.current = null;
          setDrag(null);
        }
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", release);
        window.addEventListener("pointercancel", cancel);
        window.addEventListener("keydown", key, true);
        window.addEventListener("blur", cancel);
        stop.current = end;
      },
    [box],
  );

  return { drag, grab };
}
