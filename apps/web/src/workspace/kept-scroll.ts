import { use, useLayoutEffect, useRef } from "react";
import { ActionsPaused } from "../keys/dispatcher.ts";

/** The last offset of each phone list screen, by the screen's key; it lasts as long as the page (#1553). */
const offsets = new Map<string, number>();

/** What `keepScroll` reads and listens to: a scroller's offset and its scroll events. */
export interface KeptScroller extends EventTarget {
  readonly scrollTop: number;
}

/**
 * Records `scroller`'s offset on every scroll under the screen's key as it is at that scroll, read through `currentKey`,
 * not as it was when the listener was attached: a screen whose key changes while its scroller stays mounted (one space
 * screen showing another space) files each scroll under the space in view (#1563). Returns the detach.
 */
export function keepScroll(
  scroller: KeptScroller,
  currentKey: () => string,
  store: Map<string, number> = offsets,
  events: EventTarget = scroller,
): () => void {
  const keep = (): void => {
    store.set(currentKey(), scroller.scrollTop);
  };
  events.addEventListener("scroll", keep, { passive: true });
  return () => events.removeEventListener("scroll", keep);
}

/**
 * A phone list that a terminal replaces is mounted anew by Back, at the top. This keeps the offset its reader left it at
 * (recorded on every scroll) and puts it back before the first paint once the screen's rows are there (`ready`), so Back,
 * the app's or the system's, lands where the reader was. A key the screen has not been at before starts at the top.
 *
 * The list scrolls the document itself, not a box inside it: iOS scrolls only the document to the top when the status bar
 * is tapped (#2533). The listener is attached and taken off in layout effects, so the scroll the browser makes as the
 * document shrinks under a terminal (back to 0) is never filed under the list that just left. While Settings is open over
 * the workspace the document is Settings', so the list neither records nor restores until Settings closes.
 */
export function useKeptDocumentScroll(key: string, screenReady: boolean): void {
  const ready = screenReady && !use(ActionsPaused);
  const restored = useRef<string | null>(null);
  const current = useRef(key);
  useLayoutEffect(() => {
    current.current = key;
    if (!ready) {
      restored.current = null;
      return;
    }
    if (restored.current === key) return;
    restored.current = key;
    documentScroller().scrollTop = offsets.get(key) ?? 0;
  }, [key, ready]);
  useLayoutEffect(
    () => (ready ? keepScroll(documentScroller(), () => current.current, offsets, window) : undefined),
    [ready],
  );
}

const documentScroller = (): Element => document.scrollingElement ?? document.documentElement;
