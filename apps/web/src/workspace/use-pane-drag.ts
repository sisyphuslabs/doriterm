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

/** Dropping a dragged pane header onto the top tab strip to make it its own tab. */
export interface StripDrop {
  readonly over: (x: number, y: number) => boolean;
  readonly drop: (tab: string, pane: string) => void;
}

/** A pane being dragged in a tab, and where it would land now (another pane, the top tab strip, or neither). */
export interface PaneDragState {
  readonly tab: string;
  readonly pane: string;
  readonly target: PaneDropTarget | null;
  readonly onStrip: boolean;
}

function cancelTap(touchEnd: TouchEvent): void {
  if (touchEnd.cancelable) touchEnd.preventDefault();
}

function hitAt(
  box: HTMLElement | null,
  panes: ReadonlyMap<string, Rect> | undefined,
  dragged: string,
  strip: StripDrop | undefined,
  x: number,
  y: number,
): { readonly target: PaneDropTarget | null; readonly onStrip: boolean } {
  const target = targetIn(box, panes, dragged, x, y);
  return { target, onStrip: target === null && strip?.over(x, y) === true };
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
  strip?: StripDrop,
): PaneDrag {
  const [drag, setDrag] = useState<PaneDragState | null>(null);
  const latest = useRef({ rects, onDrop, strip });
  latest.current = { rects, onDrop, strip };
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
        const touch = event.pointerType === "touch";
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
            ...hitAt(box.current, latest.current.rects(tab), pane, latest.current.strip, moved.clientX, moved.clientY),
          });
        };
        const release = (up: PointerEvent): void => {
          if (up.pointerId !== pointerId) return;
          const landed = moving
            ? hitAt(box.current, latest.current.rects(tab), pane, latest.current.strip, up.clientX, up.clientY)
            : null;
          end();
          if (landed === null) return;
          if (touch) window.addEventListener("touchend", cancelTap, { once: true, passive: false, capture: true });
          if (landed.target !== null) latest.current.onDrop(tab, pane, landed.target);
          else if (landed.onStrip) latest.current.strip?.drop(tab, pane);
        };
        const key = (down: KeyboardEvent): void => {
          if (down.key !== "Escape") return;
          down.preventDefault();
          down.stopImmediatePropagation();
          end();
        };
        const cancel = (): void => end();
        const touchMove = (each: TouchEvent): void => {
          if (moving && each.cancelable) each.preventDefault();
        };
        function end(): void {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", release);
          window.removeEventListener("pointercancel", cancel);
          window.removeEventListener("keydown", key, true);
          window.removeEventListener("blur", cancel);
          window.removeEventListener("touchmove", touchMove);
          stop.current = null;
          setDrag(null);
        }
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", release);
        window.addEventListener("pointercancel", cancel);
        window.addEventListener("keydown", key, true);
        window.addEventListener("blur", cancel);
        if (touch) window.addEventListener("touchmove", touchMove, { passive: false });
        stop.current = end;
      },
    [box],
  );

  return { drag, grab };
}
