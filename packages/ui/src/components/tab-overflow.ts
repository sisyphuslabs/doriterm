export interface TabOverflow {
  readonly start: boolean;
  readonly end: boolean;
}

export const NO_OVERFLOW: TabOverflow = { start: false, end: false };

/**
 * Which sides of a horizontal tab scroller hide overflowed tabs, with a 1 px tolerance for sub-pixel rounding.
 */
export function overflowSides(scrollLeft: number, scrollWidth: number, clientWidth: number): TabOverflow {
  if (clientWidth <= 0 || scrollWidth <= clientWidth + 1) return NO_OVERFLOW;
  return {
    start: scrollLeft > 1,
    end: scrollLeft + clientWidth < scrollWidth - 1,
  };
}
