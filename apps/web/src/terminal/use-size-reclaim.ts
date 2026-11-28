import { type RefObject, useEffect } from "react";
import type { TerminalStream } from "@doriface/client";
import type { HostSize, ViewGrid } from "./host-size.ts";

/**
 * A phone's terminal fits its box again when the page is shown again (back from another app, the phone unlocked, a page
 * restored from the back-forward cache), and gives its program the phone's size again. The core sizes the pty for the
 * view active last (attached, typed, resized or focused), and a phone's terminal takes no focus of its own until a tap,
 * so after a desktop showing the same terminal was used the program kept drawing for the desktop's width; on the
 * phone's narrower grid every redraw that moved up by the program's line count left a copy of the wrapped line behind
 * (#2819). A box that changed while the page was away is fitted the way any change of the box is (#2987).
 *
 * It claims only after this view started input (D1): a watching phone never takes the active size (HostSize.shown).
 * HostSize also holds the reclaim during a pinch.
 */
export function useSizeReclaim(
  enabled: boolean,
  grid: ViewGrid | null,
  stream: RefObject<TerminalStream | null>,
  hostSize: HostSize,
): void {
  useEffect(() => {
    if (!enabled || grid === null) return undefined;
    const shown = (): void => {
      if (document.visibilityState === "visible") hostSize.shown(stream.current, grid);
    };
    document.addEventListener("visibilitychange", shown);
    addEventListener("pageshow", shown);
    return () => {
      document.removeEventListener("visibilitychange", shown);
      removeEventListener("pageshow", shown);
    };
  }, [enabled, grid, stream, hostSize]);
}
