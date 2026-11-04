/** Where a dragged row of a vertical list lands and where the other rows are drawn meanwhile (the tab strip's rules, on y). */

export interface RowSlot {
  readonly top: number;
  readonly height: number;
}

/** A drag in progress: `to` is the index the row lands at, `offset` how far it is from its own slot. */
export interface ListDragState {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly offset: number;
  readonly slots: readonly RowSlot[];
  readonly gap: number;
}

/** The dropped (or cancelled) row easing from where it was let go into its slot. */
export interface ListSettle {
  readonly id: string;
  readonly offset: number;
  readonly running: boolean;
}

/** The index the dragged row lands at: past every other row whose centre its own centre has crossed. */
export function rowLandingIndex(slots: readonly RowSlot[], from: number, offset: number): number {
  const dragged = slots[from];
  if (dragged === undefined) return from;
  const centre = dragged.top + dragged.height / 2 + offset;
  return slots.filter((slot, index) => index !== from && slot.top + slot.height / 2 < centre).length;
}

/** How far a row that is not dragged slides aside to make room: one dragged-row height, or not at all. */
export function rowShiftOf(drag: ListDragState, index: number): number {
  const height = (drag.slots[drag.from]?.height ?? 0) + drag.gap;
  if (index > drag.from && index <= drag.to) return -height;
  if (index < drag.from && index >= drag.to) return height;
  return 0;
}

/** Where the dragged row will sit once dropped, in the list's coordinates. */
export function rowLandingTop(drag: ListDragState): number {
  const from = drag.slots[drag.from];
  const to = drag.slots[drag.to];
  if (from === undefined || to === undefined) return 0;
  return drag.to > drag.from ? to.top + to.height - from.height : to.top;
}

/** The insertion point between rows as they stand, for the caret shown when neighbours do not slide. */
export function rowCaretTop(drag: ListDragState): number {
  const to = drag.slots[drag.to];
  if (to === undefined) return 0;
  return drag.to > drag.from ? to.top + to.height + drag.gap / 2 : to.top - drag.gap / 2;
}

/** The rows' slots, from every `[data-drag-id]` element of the list (positioned against the list itself). */
export function measureRows(list: HTMLElement): { readonly slots: readonly RowSlot[]; readonly gap: number } {
  const slots = [...list.querySelectorAll<HTMLElement>("[data-drag-id]")].map((el) => ({
    top: el.offsetTop,
    height: el.offsetHeight,
  }));
  const [first, second] = slots;
  const gap = first !== undefined && second !== undefined ? second.top - first.top - first.height : 0;
  return { slots, gap };
}
