import { useCallback, useEffect, useRef, useState } from "react";

export type Fade = "none" | "start" | "end" | "both";

function fadeOf(el: HTMLElement): Fade {
  const start = el.scrollLeft > 1;
  const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
  return start && end ? "both" : start ? "start" : end ? "end" : "none";
}

/** The row's edge fade: it marks the edge the keys run on past, the sign that the row swipes for more (#195). */
export function useKeyRow(): {
  readonly fade: Fade;
  readonly row: (el: HTMLDivElement | null) => void;
} {
  const [fade, setFade] = useState<Fade>("none");
  const node = useRef<HTMLDivElement | null>(null);
  const row = useCallback((el: HTMLDivElement | null) => {
    node.current = el;
    if (el !== null) setFade(fadeOf(el));
  }, []);
  useEffect(() => {
    const el = node.current;
    if (el === null) return undefined;
    const update = (): void => setFade(fadeOf(el));
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);
  return { fade, row };
}
