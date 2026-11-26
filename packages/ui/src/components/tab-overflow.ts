import { type RefObject, useEffect, useState } from "react";

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
      const next = overflowSides(element.scrollLeft, element.scrollWidth, element.clientWidth);
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
