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
 * The width the scroller's tabs need: its last tab's layout end (offsetLeft counts the scroller's start padding, as the
 * scroller is positioned) plus its end padding. Not its scrollWidth, which also counts the hit area a coarse pointer
 * grows past the last tab's Close, so one tab on a tablet read as overflowing (#2872); and layout boxes, not client
 * rects, so a tab arriving at 0.97 scale or a dragged tab's translate does not move the answer.
 */
function tabsWidth(scroller: HTMLElement): number {
  const items = scroller.querySelectorAll<HTMLElement>("[data-tab-id]");
  const last = items[items.length - 1];
  if (last === undefined) return 0;
  return last.offsetLeft + last.offsetWidth + Number.parseFloat(getComputedStyle(scroller).paddingRight);
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
