import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { cancelTap, edgeStep, useClickLatch } from "./tab-drag-helpers.ts";
import { type DragState, landingIndex, landingLeft, measure, type Settle, type Slot } from "./tab-drop-geometry.ts";

/** Pointer travel before a press becomes a drag; less is still a click that selects. */
export const DRAG_THRESHOLD_PX = 4;
/** On touch a swipe scrolls the strip; a press held this long lifts the tab instead. */
export const TOUCH_HOLD_MS = 300;
const TOUCH_SLOP_PX = 8;
const SETTLE_MS = 200;

interface Press {
  readonly id: string;
  readonly from: number;
  readonly pointerId: number;
  readonly touch: boolean;
  readonly startX: number;
  readonly startY: number;
  armed: boolean;
  clientX: number;
  clientY: number;
  detached: boolean;
  dragging: { readonly slots: readonly Slot[]; readonly gap: number; readonly startScroll: number } | null;
}

/** Handles a tab dragged past the strip's lower edge onto another drop surface (e.g. terminal panes). */
export interface TabDragOut {
  /** Updates the external drag at (x, y); return false to keep the drag in the strip. */
  readonly move: (id: string, x: number, y: number) => boolean;
  /** Drops the detached tab at (x, y). */
  readonly drop: (id: string, x: number, y: number) => void;
  /** Cancels the external drag when the pointer returns to the strip or the drag aborts. */
  readonly cancel: () => void;
}

export interface TabDrag {
  readonly drag: DragState | null;
  readonly settle: Settle | null;
  /** The tab a held touch has lifted, before it moves. */
  readonly lifted: string | null;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>, id: string, index: number) => void;
  /** Whether a touch press is under way, so the strip can keep the browser's own long-press menu out of it. */
  readonly touching: () => boolean;
  /** Swallows the click that ends a drag, so dropping a tab never selects it. */
  readonly onClickCapture: (event: { stopPropagation(): void; preventDefault(): void }) => void;
}

export interface TabDragOptions {
  /** Gets the item and its new index; without it (and without `onDragOut`) nothing drags. */
  readonly onMove: ((id: string, to: number) => void) | undefined;
  /** Runs once a press becomes a drag. */
  readonly onStart?: () => void;
  /** A held touch let go without moving: where the finger was, for the item's menu. */
  readonly onHoldRelease?: (id: string, x: number, y: number) => void;
  /** Strip container whose bottom edge separates horizontal reorder from dragging out; defaults to `list`. */
  readonly bounds?: RefObject<HTMLElement | null>;
  /** Invoked while a dragged tab is below the strip's lower edge. */
  readonly onDragOut?: TabDragOut;
}

/** Pointer drag for a horizontal strip whose items carry `data-tab-id`. */
export function useTabDrag(
  list: RefObject<HTMLElement | null>,
  ids: readonly string[],
  { onMove, onStart, onHoldRelease, bounds, onDragOut }: TabDragOptions,
): TabDrag {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [settle, setSettle] = useState<Settle | null>(null);
  const [lifted, setLifted] = useState<string | null>(null);
  const press = useRef<Press | null>(null);
  const { arm: swallowNextClick, onClickCapture } = useClickLatch();
  const stop = useRef<() => void>(() => undefined);
  const latest = useRef({ onMove, onStart, onHoldRelease, bounds, onDragOut });
  latest.current = { onMove, onStart, onHoldRelease, bounds, onDragOut };

  const end = useCallback(() => stop.current(), []);

  const update = useCallback(() => {
    const current = press.current;
    const element = list.current;
    if (current === null || current.dragging === null || element === null) return null;
    const { slots, gap, startScroll } = current.dragging;
    const offset = current.clientX - current.startX + element.scrollLeft - startScroll;
    const next: DragState = {
      id: current.id,
      from: current.from,
      to: landingIndex(slots, current.from, offset),
      offset,
      slots,
      gap,
    };
    setDrag(next);
    return next;
  }, [list]);

  const finish = useCallback(
    (commit: boolean) => {
      const current = press.current;
      if (current?.detached) {
        const { id, clientX, clientY, touch } = current;
        current.detached = false;
        end();
        swallowNextClick();
        if (touch) window.addEventListener("touchend", cancelTap, { once: true, passive: false, capture: true });
        if (commit) latest.current.onDragOut?.drop(id, clientX, clientY);
        else latest.current.onDragOut?.cancel();
        return;
      }
      const last = current === null || current.dragging === null ? null : update();
      end();
      if (last === null) return;
      swallowNextClick();
      const to = commit ? last.to : last.from;
      const landed = commit ? landingLeft(last) : (last.slots[last.from]?.left ?? 0);
      const offset = (last.slots[last.from]?.left ?? 0) + last.offset - landed;
      setSettle({ id: last.id, offset, running: false });
      if (to !== last.from) latest.current.onMove?.(last.id, to);
    },
    [end, swallowNextClick, update],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, id: string, index: number) => {
      if (event.button !== 0 || !event.isPrimary || press.current !== null) return;
      if (latest.current.onMove === undefined && latest.current.onDragOut === undefined) return;
      if (event.target instanceof Element && event.target.closest("[data-tab-close]") !== null) return;
      const touch = event.pointerType === "touch";
      const current: Press = {
        id,
        from: index,
        pointerId: event.pointerId,
        touch,
        startX: event.clientX,
        startY: event.clientY,
        armed: !touch,
        clientX: event.clientX,
        clientY: event.clientY,
        detached: false,
        dragging: null,
      };
      press.current = current;
      let frame = 0;
      const hold = touch
        ? window.setTimeout(() => {
            current.armed = true;
            setLifted(id);
          }, TOUCH_HOLD_MS)
        : 0;
      const scrollEdges = (): void => {
        const element = list.current;
        if (element !== null && current.dragging !== null && !current.detached) {
          const step = edgeStep(current.clientX, element.getBoundingClientRect());
          if (step !== 0) {
            element.scrollLeft += step;
            update();
          }
        }
        frame = window.requestAnimationFrame(scrollEdges);
      };
      const onMoveEvent = (move: PointerEvent): void => {
        if (move.pointerId !== current.pointerId) return;
        current.clientX = move.clientX;
        current.clientY = move.clientY;
        const dx = move.clientX - current.startX;
        const dy = move.clientY - current.startY;
        if (!current.armed) {
          if (Math.hypot(dx, dy) > TOUCH_SLOP_PX) end();
          return;
        }
        if (current.dragging === null) {
          const element = list.current;
          if (element === null || Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
          current.dragging = { ...measure(element), startScroll: element.scrollLeft };
          window.getSelection()?.removeAllRanges();
          latest.current.onStart?.();
          frame = window.requestAnimationFrame(scrollEdges);
        }
        const dragOut = latest.current.onDragOut;
        const strip = latest.current.bounds?.current ?? list.current;
        const beyond = dragOut !== undefined && strip !== null && move.clientY > strip.getBoundingClientRect().bottom;
        if (beyond && dragOut.move(current.id, move.clientX, move.clientY)) {
          if (!current.detached) {
            current.detached = true;
            setDrag(null);
            setLifted(null);
          }
          return;
        }
        if (current.detached) {
          current.detached = false;
          dragOut?.cancel();
        }
        update();
      };
      const onUp = (up: PointerEvent): void => {
        if (up.pointerId !== current.pointerId) return;
        current.clientX = up.clientX;
        current.clientY = up.clientY;
        if (!current.touch || !current.armed || current.dragging !== null) return finish(true);
        // A lifted tab let go where it was: its menu opens instead of a tap selecting it. Cancelling the touchend that
        // follows keeps the browser from sending the tap's mouse events, whose mousedown would close the menu at once.
        swallowNextClick();
        window.addEventListener("touchend", cancelTap, { once: true, passive: false, capture: true });
        end();
        latest.current.onHoldRelease?.(current.id, up.clientX, up.clientY);
      };
      const onCancel = (cancel: PointerEvent): void => {
        if (cancel.pointerId === current.pointerId) finish(false);
      };
      const onKey = (key: KeyboardEvent): void => {
        if (key.key !== "Escape" || current.dragging === null) return;
        key.preventDefault();
        key.stopImmediatePropagation();
        finish(false);
      };
      const onBlur = (): void => finish(false);
      // Once a held touch has lifted the tab, moving the finger drags it instead of scrolling the strip.
      const onTouchMove = (touchMove: TouchEvent): void => {
        if (current.armed && touchMove.cancelable) touchMove.preventDefault();
      };
      window.addEventListener("pointermove", onMoveEvent);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, { capture: true });
      window.addEventListener("blur", onBlur);
      if (touch) window.addEventListener("touchmove", onTouchMove, { passive: false });
      stop.current = () => {
        window.clearTimeout(hold);
        window.cancelAnimationFrame(frame);
        window.removeEventListener("pointermove", onMoveEvent);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, { capture: true });
        window.removeEventListener("blur", onBlur);
        window.removeEventListener("touchmove", onTouchMove);
        if (current.detached) {
          current.detached = false;
          latest.current.onDragOut?.cancel();
        }
        press.current = null;
        stop.current = () => undefined;
        setDrag(null);
        setLifted(null);
      };
    },
    [end, finish, list, swallowNextClick, update],
  );

  // The settle runs in two frames: first at the drop offset with no transition, then to its slot.
  useEffect(() => {
    if (settle === null) return;
    if (!settle.running) {
      const frame = window.requestAnimationFrame(() => setSettle({ ...settle, running: true }));
      return () => window.cancelAnimationFrame(frame);
    }
    const timer = window.setTimeout(() => setSettle(null), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [settle]);

  // A tab that opens or closes mid-drag changes every index, so the drag gives up.
  const order = ids.join("\n");
  useEffect(() => end, [order, end]);

  const touching = useCallback(() => press.current?.touch === true, []);

  return { drag, settle, lifted, touching, onPointerDown, onClickCapture };
}
