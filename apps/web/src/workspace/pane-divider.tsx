import { cn } from "@doriface/ui";
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { Divider, Rect } from "../layout/rects.ts";
import type { LinePosition } from "./line-position.ts";
import { RESIZE_STEP } from "./use-pane-moves.ts";

export interface PaneDividerProps {
  readonly divider: Divider;
  /** The row or column the line splits, whose length a drag is measured against. */
  readonly container: Rect;
  /** Where the line sits and how far a resize can move it, in percent of the container, for assistive tech. */
  readonly position: LinePosition;
  /** Shows a drag as it happens; null ends the preview. */
  readonly onPreview: (delta: number | null) => void;
  /** A drag let go of: the preview stays on screen until the write replaces it. */
  readonly onDrop: (delta: number) => void;
  /** One arrow key step, or Home and End. */
  readonly onResize: (delta: number) => void;
  /** Double-clicking the divider resets pane proportions back to equal shares. */
  readonly onEqualize?: () => void;
}

/** Hit area beyond the gap's own width on each side, so the line is easy to catch without covering the panes. */
const REACH = 4;

/**
 * The line between two panes, a WAI-ARIA window splitter: drag it, or focus it and press the arrow keys along its
 * axis (one step each, Home and End for the ends), as Ghostty's resize keys move it from inside a pane.
 */
export function PaneDivider({
  divider,
  container,
  position,
  onPreview,
  onDrop,
  onResize,
  onEqualize,
}: PaneDividerProps) {
  const row = divider.axis === "row";
  const length = row ? container.width : container.height;
  const start = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const delta = (event: PointerEvent): number =>
    length <= 0 || start.current === null ? 0 : ((row ? event.clientX : event.clientY) - start.current) / length;
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = row ? event.clientX : event.clientY;
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (start.current !== null) onPreview(delta(event));
  };
  const finish = (event: PointerEvent<HTMLDivElement>, commit: boolean): void => {
    if (start.current === null) return;
    const moved = delta(event);
    start.current = null;
    setDragging(false);
    if (commit && moved !== 0) onDrop(moved);
    else onPreview(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const keys: Readonly<Record<string, number>> = row
      ? { ArrowLeft: -RESIZE_STEP, ArrowRight: RESIZE_STEP, Home: -1, End: 1 }
      : { ArrowUp: -RESIZE_STEP, ArrowDown: RESIZE_STEP, Home: -1, End: 1 };
    const step = keys[event.key];
    if (step === undefined || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    onResize(step);
  };
  const { rect } = divider;
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={row ? "vertical" : "horizontal"}
      aria-label={row ? "Resize the panes left and right" : "Resize the panes above and below"}
      aria-valuemin={Math.round(position.min)}
      aria-valuemax={Math.round(position.max)}
      aria-valuenow={Math.round(position.now)}
      data-container={divider.container}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finish(event, true)}
      onPointerCancel={(event) => finish(event, false)}
      onLostPointerCapture={(event) => finish(event, false)}
      onDoubleClick={onEqualize}
      onKeyDown={onKeyDown}
      style={
        row
          ? { left: rect.x - REACH, top: rect.y, width: rect.width + 2 * REACH, height: rect.height }
          : { left: rect.x, top: rect.y - REACH, width: rect.width, height: rect.height + 2 * REACH }
      }
      className={cn(
        "group absolute z-10 flex touch-none items-center justify-center outline-none",
        row ? "cursor-col-resize" : "cursor-row-resize",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "rounded-full transition-colors duration-(--duration-micro) group-hover:bg-ring group-focus-visible:bg-ring",
          row ? "h-full w-0.5" : "h-0.5 w-full",
          dragging ? "bg-ring" : "bg-transparent",
        )}
      />
    </div>
  );
}
