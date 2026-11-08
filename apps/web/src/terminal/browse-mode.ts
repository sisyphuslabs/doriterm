import type { WTerm } from "@wterm/react";
import { useEffect } from "react";

/** Set on a terminal that is being browsed read-only; may-take-focus.ts and styles.css read it. */
const BROWSING = "data-browsing";

/**
 * The events wterm's InputHandler answers with a mouse report to the program, a focus of its textarea (the soft
 * keyboard) or a selection of its own. All of its listeners sit on the terminal element in the bubble phase, so a
 * capture listener on the same element runs first and can stop them; pointer and touch events are not among them, so
 * the browser's own scroll and the held-press selection (use-long-press-select.ts) go on as before.
 */
const RENDERER_INPUT = ["mousedown", "mousemove", "mouseup", "click", "dblclick", "auxclick", "wheel"] as const;

export function isBrowsing(terminal: Element): boolean {
  return terminal.getAttribute(BROWSING) === "true";
}

/**
 * Read-only browsing: while on, the terminal is a page to read, not a program to drive. A touch or click reaches
 * neither the program (no mouse report) nor the renderer's input (no focus, so no soft keyboard), the stylesheet keeps
 * presses off the textarea, and `mayTakeFocus` answers false, so nothing in the app hands the keyboard back until
 * browsing ends. Selecting (a held finger, or a shift-drag), copying and scrolling keep working: they never write.
 */
export function useBrowseMode(wt: WTerm | null, browsing: boolean): void {
  useEffect(() => {
    if (wt === null || !browsing) return undefined;
    const element = wt.element;
    element.setAttribute(BROWSING, "true");
    const active = element.ownerDocument.activeElement;
    if (active instanceof HTMLElement && element.contains(active)) active.blur();
    const abort = new AbortController();
    const stop = (event: Event): void => event.stopImmediatePropagation();
    for (const type of RENDERER_INPUT) {
      element.addEventListener(type, stop, { capture: true, signal: abort.signal });
    }
    return () => {
      abort.abort();
      element.removeAttribute(BROWSING);
    };
  }, [wt, browsing]);
}
