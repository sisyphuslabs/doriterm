import { cn } from "../lib/cn.ts";
import { type ListDragState, type ListSettle, rowCaretTop, rowLandingTop, rowShiftOf } from "./list-drop-geometry.ts";

const MOTION = "transition-[translate,opacity] duration-(--duration-micro) ease-out";

/** Where a row is drawn while a drag or its settle is under way, and how it gets there. */
export function rowPlacement(id: string, index: number, drag: ListDragState | null, settle: ListSettle | null) {
  if (settle?.id === id) {
    return settle.running
      ? { offset: 0, className: cn(MOTION, "motion-reduce:translate-none!") }
      : { offset: settle.offset, className: "motion-reduce:translate-none! motion-reduce:opacity-0" };
  }
  if (drag === null) return { offset: 0, className: "" };
  if (drag.id === id)
    return { offset: drag.offset, className: "z-10 cursor-grabbing bg-raised shadow-overlay hover:bg-raised" };
  return { offset: rowShiftOf(drag, index), className: cn(MOTION, "motion-reduce:translate-none!") };
}

/** The landing place: the gap the neighbours open carries the hover wash, as on the tab strip. */
export function RowDropIndicator({ drag }: { readonly drag: ListDragState }) {
  return (
    <span
      aria-hidden
      data-row-drop-indicator
      className="pointer-events-none absolute inset-x-0 rounded-md bg-hover motion-reduce:hidden"
      style={{ top: rowLandingTop(drag), height: drag.slots[drag.from]?.height ?? 0 }}
    />
  );
}

/** The landing place under reduced motion, where neighbours stay put: a ring-coloured line between rows. */
export function RowDropCaret({ drag }: { readonly drag: ListDragState }) {
  return (
    <span
      aria-hidden
      data-row-drop-caret
      className="pointer-events-none absolute inset-x-2 hidden h-0.5 -translate-y-1/2 rounded-full bg-ring motion-reduce:block"
      style={{ top: rowCaretTop(drag) }}
    />
  );
}
