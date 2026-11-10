import type { WTerm } from "@wterm/react";
import { useEffect, useState } from "react";
import type { OutputPacer } from "./output-pacer.ts";

/**
 * Whether the pane is on screen. A pane out of view (a hidden tab, a zoomed-away split) is not painted and takes no
 * output until it shows (#560). It keeps a stream it holds but opens none: every re-attach (a new connection, or the
 * core ending the stream of a program still running) waits until it is shown, so a hidden tab does not fetch a replay
 * nobody looks at (#639), and a program that ended meanwhile is found then (#906).
 */
export function usePaneVisibility(wt: WTerm | null, pacer: OutputPacer): boolean {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    if (wt === null) return undefined;
    const apply = (visible: boolean): void => {
      setShown(visible);
      pacer.setVisible(visible);
      wt.setRenderingPaused(!visible);
    };
    // A pane mounted in a hidden tab is out of view from its first moment, before the observer's first report a frame
    // later: until then it would take output and paint part of it, which shows as a half-drawn screen when the tab is
    // switched to (#1588).
    if (wt.element.getClientRects().length === 0) apply(false);
    const seen = new IntersectionObserver((entries) => apply(entries.at(-1)?.isIntersecting ?? true));
    seen.observe(wt.element);
    return () => {
      seen.disconnect();
      wt.setRenderingPaused(false);
    };
  }, [wt, pacer]);
  // The app in the background runs no animation frame: the pacer drains on a timer then, and writes what is left at once
  // when it comes back, so returning shows the screen as it is now in one paint (D5).
  useEffect(() => {
    const follow = (): void => pacer.setHidden(document.visibilityState === "hidden");
    follow();
    document.addEventListener("visibilitychange", follow);
    addEventListener("pageshow", follow);
    return () => {
      document.removeEventListener("visibilitychange", follow);
      removeEventListener("pageshow", follow);
    };
  }, [pacer]);
  return shown;
}
