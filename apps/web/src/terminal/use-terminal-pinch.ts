import type { TerminalStream } from "@doriface/client";
import type { WTerm } from "@wterm/react";
import { type RefObject, useEffect, useRef } from "react";
import { fitGrid, type HostSize } from "./host-size.ts";
import { fontPixels } from "../ghostty/values.ts";
import { applyFontMetrics } from "./font-metrics.ts";
import { pinchFontStore } from "./pinch-font-store.ts";
import { showPinchReadout } from "./pinch-readout.ts";
import { attachPinchZoom } from "./pinch-zoom.ts";

/** DESIGN.md 6: the grid settles into its new size over --duration-settle on --ease-standard (motion-tokens.test.ts). */
export const PINCH_SETTLE: KeyframeAnimationOptions = { duration: 120, easing: "cubic-bezier(0.2, 0, 0, 1)" };
const PREVIEW_PROPERTIES = ["--term-font-size", "--term-font-pixels"] as const;

const reduced = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The grid `element` would fit at the size it now previews, from the cell its metrics were just measured at. */
function fittedGrid(element: HTMLElement, pixels: number): { readonly cols: number; readonly rows: number } {
  const style = getComputedStyle(element);
  const cell = Number.parseFloat(style.getPropertyValue("--term-native-cell-width"));
  const line = Number.parseFloat(style.getPropertyValue("--term-line-height")) || 1;
  return {
    cols: cell > 0 ? Math.max(1, Math.floor(element.clientWidth / cell)) : 0,
    rows: Math.max(1, Math.floor(element.clientHeight / (pixels * line))),
  };
}

/**
 * Pinching this terminal changes the device's terminal size (redesign section 7). While the fingers move, this terminal
 * draws at each step's size (its own font variables over the stylesheet) and the header reads the size and grid; the
 * grid refits here, but the host hears none of it (HostSize.hold), so the program is not asked to redraw for every step.
 * On release the size is saved for the device; once the stylesheet draws it, the terminal's own variables go and the
 * settled grid reaches the host once.
 */
export function useTerminalPinch(
  wt: WTerm | null,
  address: string,
  drawnSize: number,
  host: { readonly size: HostSize; readonly stream: RefObject<TerminalStream | null> },
): void {
  const size = useRef(drawnSize);
  size.current = drawnSize;
  useEffect(() => {
    if (wt === null) return undefined;
    const element = wt.element;
    let frame = 0;
    const clearPreview = (): void => {
      for (const property of PREVIEW_PROPERTIES) element.style.removeProperty(property);
      showPinchReadout(address, null);
    };
    // Two frames: the saved size's stylesheet has been applied by then, so dropping the terminal's own variables changes
    // nothing it draws, and the one fit that follows is the settled grid.
    const settle = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          clearPreview();
          applyFontMetrics(element);
          fitGrid(wt);
          host.size.release(host.stream.current);
        });
      });
    };
    const detach = attachPinchZoom(element, {
      current: () => size.current,
      preview: (next) => {
        cancelAnimationFrame(frame);
        host.size.hold();
        const pixels = fontPixels(next, navigator.platform);
        element.style.setProperty("--term-font-size", `${next}pt`);
        element.style.setProperty("--term-font-pixels", `${pixels}px`);
        applyFontMetrics(element);
        showPinchReadout(address, { size: next, ...fittedGrid(element, pixels) });
      },
      release: () => {
        showPinchReadout(address, null);
        settle();
      },
      commit: (next) => {
        void pinchFontStore.set(next);
        if (!reduced()) element.animate([{ opacity: 0.85 }, { opacity: 1 }], PINCH_SETTLE);
      },
      reset: () => {
        host.size.hold();
        void pinchFontStore.clear();
        settle();
      },
    });
    return () => {
      detach();
      cancelAnimationFrame(frame);
      clearPreview();
      host.size.release(host.stream.current);
    };
  }, [wt, address, host.size, host.stream]);
}
