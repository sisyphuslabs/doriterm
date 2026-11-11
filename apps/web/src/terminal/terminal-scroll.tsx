import { cn } from "@doriface/ui";
import type { WTerm } from "@wterm/react";
import { ArrowDown } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  awayFromBottom,
  type ScrollBox,
  scrollbarGrabAt,
  scrollbarLane,
  scrollbarRowAt,
  scrollbarThumb,
  scrollRows,
  type ScrollTarget,
  scrollTopAtRow,
  scrollTopFor,
} from "./scrollbar.ts";
import { HistoryGapMarks } from "./history-gap-marks.tsx";

/** Herdr's thumb and rail: 4 px on a 1 px rail, 2 px in from the edge, in a lane at least 8 px wide. */
const THUMB_WIDTH = 4;
const THUMB_INSET = 2;
const LANE_MIN = 8;
/** Herdr hides the bar below five columns. */
const MIN_COLS = 5;

/** What the overlay draws from: the scroll box, and where the grid sits inside the terminal's padding. */
export interface ScrollView {
  readonly box: ScrollBox;
  readonly alt: boolean;
  readonly cols: number;
  readonly padTop: number;
  readonly padBottom: number;
  /** The scrollbar's lane width: from the text's end to the pane's right edge, at least {@link LANE_MIN}. */
  readonly lane: number;
}

const px = (value: string): number => parseFloat(value) || 0;

function readView(wt: WTerm): ScrollView | null {
  const element = wt.element;
  const bridge = wt.bridge;
  const row = element.querySelector<HTMLElement>(".term-row:not(.term-scrollback-row)");
  const rowHeight = row?.getBoundingClientRect().height ?? 0;
  if (bridge === null || rowHeight <= 0) return null;
  const style = getComputedStyle(element);
  // wterm sets the cell width it lays the grid out with; the text ends `cols` cells past the content box's left.
  const cell = px(element.style.getPropertyValue("--term-cell-width"));
  const textEnd = px(style.borderLeftWidth) + px(style.paddingLeft) + wt.cols * cell;
  const lane =
    cell > 0 ? scrollbarLane(element.offsetWidth, textEnd, LANE_MIN) : Math.max(px(style.paddingRight), LANE_MIN);
  return {
    box: {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      rowHeight,
      rows: wt.rows,
      scrollback: bridge.getScrollbackCount(),
    },
    alt: bridge.usingAltScreen(),
    cols: wt.cols,
    padTop: px(style.paddingTop),
    padBottom: px(style.paddingBottom),
    lane,
  };
}

/** Moves the view to a scroll target (Lines, Pages, Top, Bottom), in whole rows. */
export function scrollTerminal(wt: WTerm, target: ScrollTarget): boolean {
  const view = readView(wt);
  if (view === null || view.alt) return false;
  wt.element.scrollTop = scrollTopFor(view.box, target);
  return true;
}

/**
 * The terminal's scroll state, read again on every scroll, resize and output. `changed` is called after each write, so
 * the bar follows output and the jump button learns of output that arrived while the view was scrolled up.
 */
export interface TerminalScroll {
  readonly changed: () => void;
  readonly view: ScrollView | null;
  /** Output arrived while the view was away from the bottom, and the view has not been back there since. */
  readonly unread: boolean;
}

export function useTerminalScroll(wt: WTerm | null): TerminalScroll {
  const store = useRef(createStore());
  const { subscribe, snapshot, read, wrote } = store.current;
  useEffect(() => {
    if (wt === null) return undefined;
    read(wt);
    const onScroll = (): void => read(wt);
    const resize = new ResizeObserver(() => read(wt));
    wt.element.addEventListener("scroll", onScroll, { passive: true });
    resize.observe(wt.element);
    return () => {
      wt.element.removeEventListener("scroll", onScroll);
      resize.disconnect();
    };
  }, [wt, read]);
  const state = useSyncExternalStore(subscribe, snapshot);
  const changed = useCallback(() => {
    if (wt !== null) wrote(wt);
  }, [wt, wrote]);
  return { changed, view: state.view, unread: state.unread };
}

interface ScrollState {
  readonly view: ScrollView | null;
  readonly unread: boolean;
}

/** One frame per change at most: output can arrive many times a frame. */
function createStore() {
  let state: ScrollState = { view: null, unread: false };
  const listeners = new Set<() => void>();
  let frame = 0;
  let wroteSince = false;
  const publish = (next: ScrollState): void => {
    state = next;
    for (const listener of listeners) listener();
  };
  const measure = (wt: WTerm): void => {
    frame = 0;
    const view = readView(wt);
    const away = view !== null && !view.alt && awayFromBottom(view.box);
    const unread = away && (state.unread || wroteSince);
    wroteSince = false;
    publish({ view, unread });
  };
  const read = (wt: WTerm): void => {
    if (frame === 0) frame = requestAnimationFrame(() => measure(wt));
  };
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && frame !== 0) cancelAnimationFrame(frame);
      };
    },
    snapshot: () => state,
    read,
    wrote: (wt: WTerm): void => {
      const view = state.view;
      if (view !== null && awayFromBottom(view.box)) wroteSince = true;
      read(wt);
    },
  };
}

const yIn = (event: ReactPointerEvent<HTMLElement>): number =>
  event.clientY - event.currentTarget.getBoundingClientRect().top;

interface OverlayProps {
  readonly wt: WTerm;
  readonly scroll: TerminalScroll;
}

/**
 * Herdr-app's pane scrollbar (`src/terminal.rs`): an overlay in the room past the grid's text, from its last column to
 * the pane's edge (the last 8 px when there is less), over the grid's rows only, so scrollback appearing never resizes the grid or reflows its text. Hidden on the
 * alternate screen, under five columns and when nothing scrolls. The lane is wider than the thumb, for the pointer.
 */
export function TerminalScrollbar({ wt, scroll }: OverlayProps) {
  const view = scroll.view;
  const drag = useRef<{ readonly pointer: number; readonly grab: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  if (view === null) return null;
  const gaps = <HistoryGapMarks wt={wt} view={view} />;
  if (view.alt || view.cols < MIN_COLS) return gaps;
  const { box } = view;
  const track = box.rows * box.rowHeight;
  const rows = scrollRows(box);
  const thumb = scrollbarThumb(rows, track, box.rowHeight);
  if (thumb === null) return gaps;
  const lane = view.lane;

  const scrollToThumbTop = (top: number): void => {
    const row = scrollbarRowAt(rows.total, rows.len, track, box.rowHeight, top);
    wt.element.scrollTop = scrollTopAtRow(box, row);
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    // The terminal keeps its focus and starts no selection under the bar.
    event.preventDefault();
    event.stopPropagation();
    const y = yIn(event);
    const grab = scrollbarGrabAt(thumb.top, thumb.length, y);
    // A press on the track beside the thumb centres the thumb there, then drags from the middle.
    if (y < thumb.top || y >= thumb.top + thumb.length) scrollToThumbTop(y - grab);
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, grab };
    setDragging(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    if (drag.current?.pointer !== event.pointerId) return;
    scrollToThumbTop(yIn(event) - drag.current.grab);
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLElement>): void => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
  };

  return (
    <>
      {gaps}
      <div
        aria-hidden
        data-terminal-scrollbar
        data-dragging={dragging ? "" : undefined}
        className="group absolute right-0 touch-none select-none"
        style={{ top: view.padTop, width: lane, height: track }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <span
          data-scrollbar-rail
          className="absolute inset-y-0 w-px bg-muted-foreground/35"
          style={{ right: THUMB_INSET + THUMB_WIDTH / 2 - 0.5 }}
        />
        <span
          data-scrollbar-thumb
          className="absolute rounded-full bg-muted-foreground"
          style={{ right: THUMB_INSET, width: THUMB_WIDTH, top: thumb.top, height: thumb.length }}
        />
      </div>
    </>
  );
}

/**
 * Back to the live bottom: a round button at the terminal's bottom right while the view is more than a row up, with a
 * dot once output arrived meanwhile. Scrolling to the bottom makes the terminal follow output again (wterm follows
 * whenever a write finds the view at the bottom). On the phone the pane already ends above the key bar.
 */
export function JumpToBottom({ wt, scroll, clearance }: OverlayProps & { readonly clearance?: string }) {
  const view = scroll.view;
  if (view === null || view.alt || !awayFromBottom(view.box)) return null;
  const label = scroll.unread ? "Jump to bottom, new output below" : "Jump to bottom";
  return (
    <button
      type="button"
      aria-label={label}
      title="Jump to bottom"
      data-jump-to-bottom
      data-unread={scroll.unread ? "" : undefined}
      className={cn(
        "absolute grid size-8 place-items-center rounded-full pointer-coarse:size-11 border border-border bg-popover text-popover-foreground shadow-overlay",
        "outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring",
        "transition-opacity duration-(--duration-micro) ease-out starting:opacity-0 motion-reduce:transition-none",
      )}
      style={{
        right: view.lane + 8,
        bottom: clearance === undefined ? view.padBottom + 8 : `calc(${view.padBottom + 8}px + ${clearance})`,
      }}
      // The terminal keeps the keyboard: a click here is not a reason to leave it.
      onPointerDown={(event) => event.preventDefault()}
      onClick={(event) => {
        scrollTerminal(wt, { to: "bottom" });
        // Pressed from the keyboard, the button had the focus and is about to go: the terminal takes it back. A tap
        // never took it, so a phone's soft keyboard stays down.
        if (document.activeElement === event.currentTarget) wt.focus();
      }}
    >
      <ArrowDown aria-hidden className="size-4" />
      {scroll.unread ? (
        <span data-unread-dot aria-hidden className="absolute top-0.5 right-0.5 size-2 rounded-full bg-primary" />
      ) : null}
    </button>
  );
}
