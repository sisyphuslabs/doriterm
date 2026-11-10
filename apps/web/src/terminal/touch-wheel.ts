import type { WTerm } from "@wterm/react";
import { useEffect } from "react";
import { longPressed } from "./long-press.ts";

/**
 * A one-finger swipe on the alternate screen turns the wheel (#1996). The grid has nothing to scroll there, so a swipe
 * left to the browser would pan the page, where a phone's pull-to-refresh reloads the app, and the full-screen program
 * would hear nothing. Each row of travel goes to the renderer as one wheel notch instead, which wterm reports to a
 * program that tracks the mouse, as it does a desktop wheel; a finger moving down scrolls back, as on any touch screen.
 * Every notch is reported in the cell the swipe began on, as a desktop wheel held still: a multiplexer sends each wheel
 * to the pane or status line under it, so a long swipe must not walk across them, nor lose its notches past the grid.
 * The normal screen keeps the browser's own pan over the scrollback. A held press's selection drag
 * (use-long-press-select.ts) is left alone, and read-only browsing stops the wheel before the renderer (browse-mode.ts).
 */
export function useTouchWheel(wt: WTerm | null): void {
  useEffect(() => (wt === null ? undefined : attachTouchWheel(wt)), [wt]);
}

/** Wires one terminal for the swipe the hook above describes and returns what unwires it. */
export function attachTouchWheel(wt: Pick<WTerm, "element" | "bridge">): () => void {
  const element = wt.element;
  /** Where the single finger down landed; null while no single finger is down. */
  let start: { readonly x: number; readonly y: number } | null = null;
  /** Where the finger was when it last turned a notch. */
  let lastY = 0;
  const onStart = (event: TouchEvent): void => {
    const finger = event.touches.length === 1 ? event.touches[0] : undefined;
    start = finger === undefined ? null : { x: finger.clientX, y: finger.clientY };
    lastY = finger?.clientY ?? 0;
  };
  const onMove = (event: TouchEvent): void => {
    const finger = event.touches.length === 1 ? event.touches[0] : undefined;
    const bridge = wt.bridge;
    if (finger === undefined || start === null) return;
    if (bridge?.usingAltScreen() !== true || longPressed(element)) return;
    if (event.cancelable) event.preventDefault();
    const row = element.querySelector(".term-row:not(.term-scrollback-row)")?.getBoundingClientRect();
    const rowHeight = row?.height ?? 0;
    const cellWidth = Number.parseFloat(element.style.getPropertyValue("--term-cell-width"));
    if (row === undefined || rowHeight <= 0 || !(cellWidth > 0)) return;
    const notches = Math.trunc((finger.clientY - lastY) / rowHeight);
    if (notches === 0) return;
    lastY += notches * rowHeight;
    // The middle of the cell the swipe began on, or of the nearest one when it began past the grid's edge.
    const col = Math.min(Math.max(Math.floor((start.x - row.left) / cellWidth), 0), bridge.getCols() - 1);
    const line = Math.min(Math.max(Math.floor((start.y - row.top) / rowHeight), 0), bridge.getRows() - 1);
    const wheel: WheelEventInit = {
      deltaY: notches > 0 ? -rowHeight : rowHeight,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      clientX: row.left + (col + 0.5) * cellWidth,
      clientY: row.top + (line + 0.5) * rowHeight,
      bubbles: true,
      cancelable: true,
    };
    for (let notch = 0; notch < Math.abs(notches); notch++) element.dispatchEvent(new WheelEvent("wheel", wheel));
  };
  const onEnd = (): void => {
    start = null;
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
