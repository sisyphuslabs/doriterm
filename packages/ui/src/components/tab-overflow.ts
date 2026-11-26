import { type RefObject, useEffect, useState } from "react";

export interface TabOverflow {
  readonly start: boolean;
  readonly end: boolean;
}

export const NO_OVERFLOW: TabOverflow = { start: false, end: false };

/**
 * Which sides of a horizontal tab scroller hide overflowed tabs, given the width its tabs need, with a 1 px tolerance
 * for sub-pixel rounding.
 */
export function overflowSides(scrollLeft: number, needed: number, clientWidth: number): TabOverflow {
  if (clientWidth <= 0 || needed <= clientWidth + 1) return NO_OVERFLOW;
  return {
    start: scrollLeft > 1,
    end: scrollLeft + clientWidth < needed - 1,
  };
}

/**
 * The width the scroller's tabs need: from its first tab's start to its last tab's end, plus its own padding. Not its
 * scrollWidth, which also counts the hit area a coarse pointer grows past the last tab's close button, so one tab on a
 * tablet read as overflowing (#2872).
 */
function tabsWidth(scroller: HTMLElement): number {
  const items = scroller.querySelectorAll("[data-tab-id]");
  const first = items[0];
  const last = items[items.length - 1];
  if (first === undefined || last === undefined) return 0;
  const { paddingLeft, paddingRight } = getComputedStyle(scroller);
  const span = last.getBoundingClientRect().right - first.getBoundingClientRect().left;
  return span + Number.parseFloat(paddingLeft) + Number.parseFloat(paddingRight);
}

/** Tracks which horizontal edges of `scroller` overflow as it scrolls, resizes, or changes children. */
export function useTabOverflow(
  scroller: RefObject<HTMLElement | null>,
  enabled: boolean,
  layoutKey: string,
): TabOverflow {
  const [edges, setEdges] = useState<TabOverflow>(NO_OVERFLOW);
  useEffect(() => {
    if (!enabled) {
      setEdges(NO_OVERFLOW);
      return undefined;
    }
    const element = scroller.current;
    if (element === null) return undefined;
    const update = (): void => {
      const next = overflowSides(element.scrollLeft, tabsWidth(element), element.clientWidth);
      setEdges((current) => (current.start === next.start && current.end === next.end ? current : next));
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(element);
    for (const child of element.children) resize.observe(child);
    return () => {
      element.removeEventListener("scroll", update);
      resize.disconnect();
    };
  }, [scroller, enabled, layoutKey]);
  return enabled ? edges : NO_OVERFLOW;
}
