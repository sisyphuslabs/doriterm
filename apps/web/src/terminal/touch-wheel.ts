import type { WTerm } from "@wterm/react";
import { useEffect } from "react";
import { longPressed } from "./long-press.ts";

/**
 * A one-finger swipe on the alternate screen turns the wheel (#1996). The grid has nothing to scroll there, so a swipe
 * left to the browser would pan the page, where a phone's pull-to-refresh reloads the app, and the full-screen program
 * would hear nothing. Each row of travel goes to the renderer as one wheel notch instead, which wterm reports to a
 * program that tracks the mouse, as it does a desktop wheel; a finger moving down scrolls back, as on any touch screen.
 * The normal screen keeps the browser's own pan over the scrollback. A held press's selection drag
 * (use-long-press-select.ts) is left alone, and read-only browsing stops the wheel before the renderer (browse-mode.ts).
 */
export function useTouchWheel(wt: WTerm | null): void {
  useEffect(() => (wt === null ? undefined : attachTouchWheel(wt)), [wt]);
}

/** Wires one terminal for the swipe the hook above describes and returns what unwires it. */
export function attachTouchWheel(wt: Pick<WTerm, "element" | "bridge">): () => void {
  const element = wt.element;
  /** Where the finger was when it last turned a notch; null while no single finger is down. */
  let lastY: number | null = null;
  const onStart = (event: TouchEvent): void => {
    lastY = event.touches.length === 1 ? (event.touches[0]?.clientY ?? null) : null;
  };
  const onMove = (event: TouchEvent): void => {
    const finger = event.touches.length === 1 ? event.touches[0] : undefined;
    if (finger === undefined || lastY === null) return;
    if (wt.bridge?.usingAltScreen() !== true || longPressed(element)) return;
    if (event.cancelable) event.preventDefault();
    const rowHeight = element.querySelector(".term-row:not(.term-scrollback-row)")?.getBoundingClientRect().height ?? 0;
    if (rowHeight <= 0) return;
    const notches = Math.trunc((finger.clientY - lastY) / rowHeight);
    if (notches === 0) return;
    lastY += notches * rowHeight;
    const wheel: WheelEventInit = {
      deltaY: notches > 0 ? -rowHeight : rowHeight,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      clientX: finger.clientX,
      clientY: finger.clientY,
      bubbles: true,
      cancelable: true,
    };
    for (let notch = 0; notch < Math.abs(notches); notch++) element.dispatchEvent(new WheelEvent("wheel", wheel));
  };
  const onEnd = (): void => {
    lastY = null;
  };
  element.addEventListener("touchstart", onStart, { passive: true });
  element.addEventListener("touchmove", onMove, { passive: false });
  element.addEventListener("touchend", onEnd);
  element.addEventListener("touchcancel", onEnd);
  return () => {
    element.removeEventListener("touchstart", onStart);
    element.removeEventListener("touchmove", onMove);
    element.removeEventListener("touchend", onEnd);
    element.removeEventListener("touchcancel", onEnd);
  };
}
