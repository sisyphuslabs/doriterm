import { type RefObject, useEffect, useState } from "react";

export interface ScrollEdges {
  /** Content is scrolled past the start edge. */
  readonly start: boolean;
  /** Content continues past the end edge. */
  readonly end: boolean;
}

/** Which edges of a horizontally scrolling box hide content. A pixel of slack absorbs fractional scroll positions. */
export function scrollEdges(box: {
  readonly scrollLeft: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
}): ScrollEdges {
  return { start: box.scrollLeft > 1, end: box.scrollLeft + box.clientWidth < box.scrollWidth - 1 };
}

/** Tracks scrollEdges of the element as it scrolls and as it or its content resizes. */
export function useScrollEdges(ref: RefObject<HTMLElement | null>): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>({ start: false, end: false });
  useEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const update = (): void => {
      const next = scrollEdges(element);
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
  }, [ref]);
  return edges;
}
