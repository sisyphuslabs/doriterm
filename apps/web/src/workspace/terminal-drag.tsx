import { ROW_DRAG_THRESHOLD_PX, ROW_TOUCH_HOLD_MS } from "@doriface/ui";
import {
  createContext,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { TerminalDropTarget } from "./use-terminal-drops.ts";

/** A held touch that moves this far before it lifts the row was a swipe: the list scrolls and nothing drags. */
const TOUCH_SLOP_PX = 8;

/** A terminal dragged from the sidebar, or a tab dragged from the top tab bar, over the workspace panes. */
export type TerminalDrag =
  | {
      readonly kind: "terminal";
      readonly address: string;
      readonly name: string;
      readonly x: number;
      readonly y: number;
      readonly target: TerminalDropTarget | null;
    }
  | {
      readonly kind: "tab";
      readonly tab: string;
      readonly name: string;
      readonly x: number;
      readonly y: number;
      readonly target: TerminalDropTarget | null;
    };

/** The panes a sidebar drag or tab-strip drag drops on: what lies under a point, and the drop itself. */
export interface TerminalDropSurface {
  readonly targetAt: (address: string, x: number, y: number) => TerminalDropTarget | null;
  readonly drop: (address: string, target: TerminalDropTarget) => void;
  readonly canDropTab: (tabKey: string) => boolean;
  readonly tabTargetAt: (tabKey: string, x: number, y: number) => TerminalDropTarget | null;
  readonly dropTab: (tabKey: string, target: TerminalDropTarget) => void;
}

/** Bridge connecting the top TabBar's outside-drag callbacks to the pane drop surface. */
export interface TabDropBridge {
  readonly onDragOutside: (
    drag: { readonly id: string; readonly title: string; readonly x: number; readonly y: number } | null,
  ) => boolean;
  readonly onDropOutside: (id: string, x: number, y: number) => boolean;
}

/** What a sidebar row needs to be dragged: its pointer press, and the click a drag swallows so a drop never opens it. */
export interface TerminalGrab {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>, address: string, name: string) => void;
  readonly onClickCapture: (event: { stopPropagation(): void; preventDefault(): void }) => void;
}

interface Grabbing extends TerminalGrab {
  readonly surface: { current: TerminalDropSurface | null };
  readonly tabBridge: TabDropBridge;
}

const GrabContext = createContext<Grabbing | null>(null);
const DragContext = createContext<TerminalDrag | null>(null);

function cancelTap(touchEnd: TouchEvent): void {
  if (touchEnd.cancelable) touchEnd.preventDefault();
}

/**
 * Lets an agent row of the sidebar be dragged onto the panes, where it becomes a pane (herdr-app's pane drag, from the
 * list): a mouse or pen press that travels past the threshold drags it; on touch a swipe scrolls the list and a press
 * held for the list's hold lifts the row first. Escape, a lost pointer or window, or a release over no pane drops
 * nothing.
 */
export function TerminalDragProvider({ children }: { readonly children: ReactNode }) {
  const [drag, setDrag] = useState<TerminalDrag | null>(null);
  const surface = useRef<TerminalDropSurface | null>(null);
  const swallowClick = useRef(false);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>, address: string, name: string): void => {
    swallowClick.current = false;
    if (event.button !== 0 || !event.isPrimary) return;
    stop.current?.();
    const touch = event.pointerType === "touch";
    const { pointerId, clientX: startX, clientY: startY } = event;
    let armed = !touch;
    let moving = false;
    const at = (x: number, y: number): TerminalDrag => ({
      kind: "terminal",
      address,
      name,
      x,
      y,
      target: surface.current?.targetAt(address, x, y) ?? null,
    });
    const hold = touch
      ? window.setTimeout(() => {
          armed = true;
          setDrag(at(startX, startY));
        }, ROW_TOUCH_HOLD_MS)
      : 0;
    const move = (moved: PointerEvent): void => {
      if (moved.pointerId !== pointerId) return;
      const travel = Math.hypot(moved.clientX - startX, moved.clientY - startY);
      if (!armed) {
        if (travel > TOUCH_SLOP_PX) end();
        return;
      }
      if (!moving && travel < ROW_DRAG_THRESHOLD_PX) return;
      if (!moving) window.getSelection()?.removeAllRanges();
      moving = true;
      setDrag(at(moved.clientX, moved.clientY));
    };
    const release = (up: PointerEvent): void => {
      if (up.pointerId !== pointerId) return;
      const target = moving ? at(up.clientX, up.clientY).target : null;
      const lifted = armed && (moving || touch);
      end();
      if (!lifted) return;
      swallowClick.current = true;
      // The tap a held touch ends in would open the row: cancelling its touchend keeps the browser from sending it.
      if (touch) window.addEventListener("touchend", cancelTap, { once: true, passive: false, capture: true });
      if (target !== null) surface.current?.drop(address, target);
    };
    const key = (down: KeyboardEvent): void => {
      if (down.key !== "Escape" || !moving) return;
      down.preventDefault();
      down.stopImmediatePropagation();
      end();
    };
    const cancel = (): void => end();
    // Once a held touch has lifted the row, moving the finger drags it instead of scrolling the list.
    const touchMove = (each: TouchEvent): void => {
      if (armed && each.cancelable) each.preventDefault();
    };
    function end(): void {
      window.clearTimeout(hold);
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
  }, []);

  const onClickCapture = useCallback((event: { stopPropagation(): void; preventDefault(): void }): void => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    event.stopPropagation();
    event.preventDefault();
  }, []);

  const onTabDragOutside = useCallback<TabDropBridge["onDragOutside"]>((outside) => {
    if (outside === null) {
      setDrag((prev) => (prev?.kind === "tab" ? null : prev));
      return false;
    }
    const activeSurface = surface.current;
    if (activeSurface === null || !activeSurface.canDropTab(outside.id)) {
      setDrag((prev) => (prev?.kind === "tab" ? null : prev));
      return false;
    }
    setDrag({
      kind: "tab",
      tab: outside.id,
      name: outside.title,
      x: outside.x,
      y: outside.y,
      target: activeSurface.tabTargetAt(outside.id, outside.x, outside.y),
    });
    return true;
  }, []);

  const onTabDropOutside = useCallback<TabDropBridge["onDropOutside"]>((id, x, y) => {
    const activeSurface = surface.current;
    const target = activeSurface?.tabTargetAt(id, x, y) ?? null;
    setDrag((prev) => (prev?.kind === "tab" ? null : prev));
    if (activeSurface === null || target === null) return false;
    activeSurface.dropTab(id, target);
    return true;
  }, []);

  const grabbing = useMemo<Grabbing>(
    () => ({
      onPointerDown,
      onClickCapture,
      surface,
      tabBridge: { onDragOutside: onTabDragOutside, onDropOutside: onTabDropOutside },
    }),
    [onPointerDown, onClickCapture, onTabDragOutside, onTabDropOutside],
  );
  return (
    <GrabContext.Provider value={grabbing}>
      <DragContext.Provider value={drag}>
        {children}
        {drag === null ? null : <DragChip drag={drag} />}
      </DragContext.Provider>
    </GrabContext.Provider>
  );
}

/**
 * The dragged agent's or tab's name beside the pointer, so the person sees what they hold over the panes: below and
 * right of it, or left of it in the window's right quarter, where it would run off the edge.
 */
function DragChip({ drag }: { readonly drag: TerminalDrag }) {
  const flip = drag.x > window.innerWidth * 0.75;
  return (
    <div
      aria-hidden
      {...(drag.kind === "terminal" ? { "data-terminal-drag": drag.address } : { "data-tab-drag": drag.tab })}
      className="pointer-events-none fixed z-50 max-w-60 truncate rounded-md border border-border bg-popover px-2 py-1 text-sm text-popover-foreground shadow-md"
      style={{
        left: drag.x,
        top: drag.y,
        transform: flip ? "translate(calc(-100% - 12px), 12px)" : "translate(12px, 12px)",
      }}
    >
      {drag.name}
    </div>
  );
}

/** A row's drag handlers, or null outside the desktop shell (the phone shows no panes beside its lists). */
export function useTerminalGrab(): TerminalGrab | null {
  return useContext(GrabContext);
}

/** Bridge for dragging tabs from the top TabBar onto workspace panes; null outside TerminalDragProvider. */
export function useTabDropBridge(): TabDropBridge | null {
  return useContext(GrabContext)?.tabBridge ?? null;
}

/** The sidebar or tab-bar drag under way, for the panes to preview its drop. */
export function useTerminalDrag(): TerminalDrag | null {
  return useContext(DragContext);
}

/** Makes `surface` the panes a sidebar or tab-bar drag drops on, while the caller is mounted. */
export function useTerminalDropSurface(surface: TerminalDropSurface): void {
  const grabbing = useContext(GrabContext);
  const latest = useRef(surface);
  latest.current = surface;
  useEffect(() => {
    if (grabbing === null) return undefined;
    const ref = grabbing.surface;
    ref.current = {
      targetAt: (address, x, y) => latest.current.targetAt(address, x, y),
      drop: (address, target) => latest.current.drop(address, target),
      canDropTab: (tabKey) => latest.current.canDropTab(tabKey),
      tabTargetAt: (tabKey, x, y) => latest.current.tabTargetAt(tabKey, x, y),
      dropTab: (tabKey, target) => latest.current.dropTab(tabKey, target),
    };
    return () => {
      ref.current = null;
    };
  }, [grabbing]);
}
