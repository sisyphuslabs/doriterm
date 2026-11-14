import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";

export type Fade = "none" | "start" | "end" | "both";

function fadeOf(el: HTMLElement): Fade {
  const start = el.scrollLeft > 1;
  const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
  return start && end ? "both" : start ? "start" : end ? "end" : "none";
}

/** The least of a cut key the row keeps in view, so a key half shown says the row swipes for more (#2604). */
const PEEK_MIN = 16;
/** How much of the next key a cut shows, as a share of its width. */
const PEEK_SHARE = 0.4;

/**
 * The width the row takes of `room` so that its last key in view is cut, never whole: a row that ended on a key, or on a
 * sliver too thin to read, would give no sign that more keys lie past it. The first key that does not fit shows as it
 * falls when at least PEEK_MIN of it is in view; otherwise the key before it is cut to PEEK_SHARE of its width. A row
 * whose keys all fit takes the room as it is.
 */
export function peekWidth(room: number, keys: readonly { readonly left: number; readonly width: number }[]): number {
  const at = keys.findIndex((entry) => entry.left + entry.width > room);
  const over = keys[at];
  if (over === undefined || room - over.left >= PEEK_MIN) return room;
  const cut = keys[at - 1];
  if (cut === undefined) return room;
  return Math.round(cut.left + Math.max(PEEK_MIN, cut.width * PEEK_SHARE));
}

/**
 * The row's edge fade and its width: the fade marks the edge the keys run on past, and the width (set on the row inside
 * a slot that takes the room) cuts the last key in view so the row reads as one that swipes (#195, #2604).
 */
export function useKeyRow(): {
  readonly fade: Fade;
  readonly slot: (el: HTMLDivElement | null) => void;
  readonly row: (el: HTMLDivElement | null) => void;
  readonly style: CSSProperties;
} {
  const [fade, setFade] = useState<Fade>("none");
  const [width, setWidth] = useState<number | undefined>(undefined);
  const slotNode = useRef<HTMLDivElement | null>(null);
  const rowNode = useRef<HTMLDivElement | null>(null);
  const slot = useCallback((el: HTMLDivElement | null) => {
    slotNode.current = el;
  }, []);
  const row = useCallback((el: HTMLDivElement | null) => {
    rowNode.current = el;
    if (el !== null) setFade(fadeOf(el));
  }, []);
  useEffect(() => {
    const outer = slotNode.current;
    const inner = rowNode.current;
    if (outer === null || inner === null) return undefined;
    const measure = (): void => {
      const start = inner.getBoundingClientRect().left - inner.scrollLeft;
      const keys = [...inner.children].map((child) => {
        const box = child.getBoundingClientRect();
        return { left: box.left - start, width: box.width };
      });
      setWidth(peekWidth(outer.clientWidth, keys));
      setFade(fadeOf(inner));
    };
    measure();
    const update = (): void => setFade(fadeOf(inner));
    inner.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    observer.observe(inner);
    return () => {
      inner.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);
  return { fade, slot, row, style: width === undefined ? {} : { width } };
}
