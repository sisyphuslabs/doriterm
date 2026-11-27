/** Where a dragged tab lands and where everything else is drawn meanwhile, from the slots measured at drag start. */

export interface Slot {
  readonly left: number;
  readonly width: number;
}

/** A drag in progress: `to` is the index the tab lands at, `offset` how far it is from its own slot. */
export interface DragState {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly offset: number;
  readonly slots: readonly Slot[];
  readonly gap: number;
}

/** The dropped (or cancelled) tab easing from where it was let go into its slot. */
export interface Settle {
  readonly id: string;
  readonly offset: number;
  readonly running: boolean;
}

/** The index the dragged tab lands at: past every other tab whose centre its own centre has crossed. */
export function landingIndex(slots: readonly Slot[], from: number, offset: number): number {
  const dragged = slots[from];
  if (dragged === undefined) return from;
  const centre = dragged.left + dragged.width / 2 + offset;
  return slots.filter((slot, index) => index !== from && slot.left + slot.width / 2 < centre).length;
}

/**
 * Clamps the dragged tab's visual horizontal offset to the strip's own first-to-last slot span so translating it past
 * the end never expands `scrollWidth` or triggers runaway auto-scrolling into empty space.
 */
export function clampOffset(slots: readonly Slot[], from: number, offset: number): number {
  const dragged = slots[from];
  const first = slots[0];
  const last = slots.at(-1);
  if (dragged === undefined || first === undefined || last === undefined) return 0;
  const min = first.left - dragged.left;
  const max = last.left + last.width - (dragged.left + dragged.width);
  return Math.min(Math.max(offset, min), max);
}

/** How far a tab that is not dragged slides aside to make room: one dragged-tab width, or not at all. */
export function shiftOf(drag: DragState, index: number): number {
  const width = (drag.slots[drag.from]?.width ?? 0) + drag.gap;
  if (index > drag.from && index <= drag.to) return -width;
  if (index < drag.from && index >= drag.to) return width;
  return 0;
}

/** Where the dragged tab will sit once dropped, in the strip's content coordinates. */
export function landingLeft(drag: DragState): number {
  const from = drag.slots[drag.from];
  const to = drag.slots[drag.to];
  if (from === undefined || to === undefined) return 0;
  return drag.to > drag.from ? to.left + to.width - from.width : to.left;
}

/** The insertion point between tabs as they stand, for the caret shown when neighbours do not slide. */
export function caretLeft(drag: DragState): number {
  const to = drag.slots[drag.to];
  if (to === undefined) return 0;
  return drag.to > drag.from ? to.left + to.width + drag.gap / 2 : to.left - drag.gap / 2;
}

export function measure(list: HTMLElement): { readonly slots: readonly Slot[]; readonly gap: number } {
  const slots = [...list.querySelectorAll<HTMLElement>("[data-tab-id]")].map((el) => ({
    left: el.offsetLeft,
    width: el.offsetWidth,
  }));
  const [first, second] = slots;
  const gap = first !== undefined && second !== undefined ? second.left - first.left - first.width : 0;
  return { slots, gap };
}
