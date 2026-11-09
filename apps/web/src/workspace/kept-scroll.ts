import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** The last offset of each phone list screen, by the screen's key; it lasts as long as the page (#1553). */
const offsets = new Map<string, number>();

/**
 * A phone list that a terminal replaces is mounted anew by Back, at the top. This keeps the offset its reader left it at
 * (recorded on every scroll) and puts it back before the first paint once the screen's rows are there (`ready`), so Back,
 * the app's or the system's, lands where the reader was. A key the screen has not been at before starts at the top.
 *
 * The result is a ref for the element that scrolls. It follows that element, not the component: the agents list comes
 * and goes under a shell that stays mounted while a terminal is open.
 */
export function useKeptScroll(key: string, ready: boolean): (element: HTMLDivElement | null) => void {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const restored = useRef<{ readonly element: HTMLDivElement; readonly key: string } | null>(null);
  useLayoutEffect(() => {
    if (element === null || !ready) return;
    if (restored.current?.element === element && restored.current.key === key) return;
    restored.current = { element, key };
    element.scrollTop = offsets.get(key) ?? 0;
  }, [element, key, ready]);
  useEffect(() => {
    if (element === null) return;
    const keep = (): void => {
      offsets.set(key, element.scrollTop);
    };
    element.addEventListener("scroll", keep, { passive: true });
    return () => element.removeEventListener("scroll", keep);
  }, [element, key]);
  return setElement;
}
