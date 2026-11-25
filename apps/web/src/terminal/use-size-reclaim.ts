import { type RefObject, useEffect } from "react";
import type { TerminalStream } from "@doriface/client";

/** The grid a view renders, which it hands the core again. */
interface Grid {
  readonly cols: number;
  readonly rows: number;
}

/**
 * A phone's terminal gives its program the phone's size again when the page is shown again (back from another app,
 * the phone unlocked). The core sizes the pty for the view active last (attached, typed, resized or focused), and a
 * phone's terminal takes no focus of its own until a tap, so after a desktop showing the same terminal was used the
 * program kept drawing for the desktop's width; on the phone's narrower grid every redraw that moved up by the
 * program's line count left a copy of the wrapped line behind (#2819).
 *
 * It claims only then, never on its own: a desktop the person is typing at keeps the size while the phone lies open.
 */
export function useSizeReclaim(enabled: boolean, grid: Grid | null, stream: RefObject<TerminalStream | null>): void {
  useEffect(() => {
    if (!enabled || grid === null) return undefined;
    const shown = (): void => {
      if (document.visibilityState === "visible") stream.current?.resize(grid.cols, grid.rows);
    };
    document.addEventListener("visibilitychange", shown);
    return () => document.removeEventListener("visibilitychange", shown);
  }, [enabled, grid, stream]);
}
