import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type ListDragState,
  type ListSettle,
  measureRows,
  type RowSlot,
  rowLandingIndex,
  rowLandingTop,
} from "./list-drop-geometry.ts";

/** Pointer travel before a press becomes a drag; less is still a click. The tab strip uses the same distances. */
export const ROW_DRAG_THRESHOLD_PX = 4;
/** On touch a swipe scrolls the list; a press held this long lifts the row instead. */
export const ROW_TOUCH_HOLD_MS = 300;
const TOUCH_SLOP_PX = 8;
const SETTLE_MS = 200;

function cancelTap(touchEnd: TouchEvent): void {
  if (touchEnd.cancelable) touchEnd.preventDefault();
}

interface Press {
  readonly id: string;
  readonly from: number;
  readonly pointerId: number;
  readonly touch: boolean;
  readonly startY: number;
  readonly startX: number;
  armed: boolean;
  clientY: number;
  dragging: { readonly slots: readonly RowSlot[]; readonly gap: number; readonly listTop: number } | null;
}

export interface ListDrag {
  readonly drag: ListDragState | null;
  readonly settle: ListSettle | null;
  /** The row a held touch has lifted, before it moves. */
  readonly lifted: string | null;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>, id: string, index: number) => void;
  /** Whether a touch press is under way, so the list can keep the browser's own long-press menu out of it. */
  readonly touching: () => boolean;
  /** Swallows the click that ends a drag, so dropping a row never opens it. */
  readonly onClickCapture: (event: { stopPropagation(): void; preventDefault(): void }) => void;
}

export interface ListDragOptions {
  /** Gets the row and its new index; without it nothing drags. */
  readonly onMove: ((id: string, to: number) => void) | undefined;
  readonly onStart?: () => void;
  /** A held touch let go without moving: where the finger was, for the row's menu. */
  readonly onHoldRelease?: (id: string, x: number, y: number) => void;
}

/**
 * Pointer drag for a vertical list whose rows carry `data-drag-id`, the tab strip's drag on the other axis. The offset
 * follows the list's own box, so a list that scrolls under the pointer mid-drag still lands where the row is drawn.
 * A press on an element marked `data-drag-ignore` (a row's action button) never drags.
 */
export function useListDrag(
  list: RefObject<HTMLElement | null>,
  ids: readonly string[],
  { onMove, onStart, onHoldRelease }: ListDragOptions,
): ListDrag {
  const [drag, setDrag] = useState<ListDragState | null>(null);
  const [settle, setSettle] = useState<ListSettle | null>(null);
  const [lifted, setLifted] = useState<string | null>(null);
  const press = useRef<Press | null>(null);
  const swallowClick = useRef(false);
  const stop = useRef<() => void>(() => undefined);
  const latest = useRef({ onMove, onStart, onHoldRelease });
  latest.current = { onMove, onStart, onHoldRelease };

  const end = useCallback(() => stop.current(), []);

  const update = useCallback(() => {
    const current = press.current;
    const element = list.current;
    if (current === null || current.dragging === null || element === null) return null;
    const { slots, gap, listTop } = current.dragging;
    const offset = current.clientY - current.startY - (element.getBoundingClientRect().top - listTop);
    const next: ListDragState = {
      id: current.id,
      from: current.from,
      to: rowLandingIndex(slots, current.from, offset),
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
      const last = current === null || current.dragging === null ? null : update();
      end();
      if (last === null) return;
      swallowClick.current = true;
      const to = commit ? last.to : last.from;
      const landed = commit ? rowLandingTop(last) : (last.slots[last.from]?.top ?? 0);
      const offset = (last.slots[last.from]?.top ?? 0) + last.offset - landed;
      setSettle({ id: last.id, offset, running: false });
      if (to !== last.from) latest.current.onMove?.(last.id, to);
    },
    [end, update],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, id: string, index: number) => {
      swallowClick.current = false;
      if (event.button !== 0 || press.current !== null || latest.current.onMove === undefined) return;
      if (event.target instanceof Element && event.target.closest("[data-drag-ignore]") !== null) return;
      const touch = event.pointerType === "touch";
      const current: Press = {
        id,
        from: index,
        pointerId: event.pointerId,
        touch,
        startY: event.clientY,
        startX: event.clientX,
        armed: !touch,
        clientY: event.clientY,
        dragging: null,
      };
      press.current = current;
      const hold = touch
        ? window.setTimeout(() => {
            current.armed = true;
            setLifted(id);
          }, ROW_TOUCH_HOLD_MS)
        : 0;
      const onMoveEvent = (move: PointerEvent): void => {
        if (move.pointerId !== current.pointerId) return;
        current.clientY = move.clientY;
        const travel = Math.hypot(move.clientX - current.startX, move.clientY - current.startY);
        if (!current.armed) {
          if (travel > TOUCH_SLOP_PX) end();
          return;
        }
        if (current.dragging === null) {
          const element = list.current;
          if (element === null || travel < ROW_DRAG_THRESHOLD_PX) return;
          current.dragging = { ...measureRows(element), listTop: element.getBoundingClientRect().top };
          window.getSelection()?.removeAllRanges();
          latest.current.onStart?.();
        }
        update();
      };
      const onUp = (up: PointerEvent): void => {
        if (up.pointerId !== current.pointerId) return;
        if (!current.touch || !current.armed || current.dragging !== null) return finish(true);
        // A lifted row let go where it was: its menu opens instead of a tap opening it. Cancelling the touchend that
        // follows keeps the browser from sending the tap's mouse events, whose mousedown would close the menu at once.
        swallowClick.current = true;
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
        key.stopPropagation();
        finish(false);
      };
      const onBlur = (): void => finish(false);
      const onScroll = (): void => void update();
      // Once a held touch has lifted the row, moving the finger drags it instead of scrolling the list.
      const onTouchMove = (touchMove: TouchEvent): void => {
        if (current.armed && touchMove.cancelable) touchMove.preventDefault();
      };
      window.addEventListener("pointermove", onMoveEvent);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, { capture: true });
      window.addEventListener("blur", onBlur);
      window.addEventListener("scroll", onScroll, { capture: true, passive: true });
      if (touch) window.addEventListener("touchmove", onTouchMove, { passive: false });
      stop.current = () => {
        window.clearTimeout(hold);
        window.removeEventListener("pointermove", onMoveEvent);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, { capture: true });
        window.removeEventListener("blur", onBlur);
        window.removeEventListener("scroll", onScroll, { capture: true });
        window.removeEventListener("touchmove", onTouchMove);
        press.current = null;
        stop.current = () => undefined;
        setDrag(null);
        setLifted(null);
      };
    },
    [end, finish, list, update],
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

  // A row that comes or goes mid-drag changes every index, so the drag gives up.
  const order = ids.join("\n");
  useEffect(() => end, [order, end]);

  const onClickCapture = useCallback((event: { stopPropagation(): void; preventDefault(): void }) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    event.stopPropagation();
    event.preventDefault();
  }, []);

  const touching = useCallback(() => press.current?.touch === true, []);

  return { drag, settle, lifted, touching, onPointerDown, onClickCapture };
}
