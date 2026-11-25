import { guardedLocalStorage } from "../storage/guarded.ts";

/** A phone's split focus (design proposal section 6): two panes of a split tab, real terminals, one in focus. */

export const DEFAULT_RATIO = 0.55;
const MIN_RATIO = 0.3;
const MAX_RATIO = 0.7;

/** The first half's share of the split, within 30:70 and 70:30; anything that is not a number is the default. */
export const clampRatio = (ratio: number): number =>
  Number.isFinite(ratio) ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)) : DEFAULT_RATIO;

/**
 * The two panes split focus shows, in the tab's order: the focused one and the one seen before it, else the focused
 * one's neighbour (the next, or the one before the last). Null when there is no split to show.
 */
export function focusPair(
  panes: readonly string[],
  open: string,
  previous: string | null,
): readonly [string, string] | null {
  const at = panes.indexOf(open);
  if (panes.length < 2 || at === -1) return null;
  const seen = previous === null || previous === open ? -1 : panes.indexOf(previous);
  const other = seen !== -1 ? seen : at + 1 < panes.length ? at + 1 : at - 1;
  const [first, second] = at < other ? [open, panes[other]] : [panes[other], open];
  return first === undefined || second === undefined ? null : [first, second];
}

/** Side by side in a landscape box, stacked top and bottom otherwise. */
export const splitBeside = (width: number, height: number): boolean => width > height;

const key = (tab: string): string => `doriface.split-focus.${tab}`;

/** This device's ratio for a tab: it never changes the tab's own split, which other devices share. */
export function storedRatio(tab: string): number {
  const raw = guardedLocalStorage().getItem(key(tab));
  return raw === null ? DEFAULT_RATIO : clampRatio(Number(raw));
}

export function storeRatio(tab: string, ratio: number): void {
  guardedLocalStorage().setItem(key(tab), String(clampRatio(ratio)));
}
