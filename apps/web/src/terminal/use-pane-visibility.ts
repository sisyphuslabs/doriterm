import type { WTerm } from "@wterm/react";
import { useEffect, useState } from "react";
import type { OutputPacer } from "./output-pacer.ts";

/**
 * Whether the pane is on screen. A pane out of view (a hidden tab, a zoomed-away split) is not painted and takes no
 * output until it shows (#560). It keeps a stream it holds but opens none: its first attach (a background tab after a
 * reload, #1187) and every re-attach (a new connection, or the core ending the stream of a program still running) wait
 * until it is shown, so a hidden tab does not fetch a replay nobody looks at (#639), and a program that ended meanwhile
 * is found then (#906). Not shown until the first observation says so, so a pane mounted out of view never attaches.
 */
export function usePaneVisibility(wt: WTerm | null, pacer: OutputPacer): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (wt === null) return undefined;
    let shownNow = false;
    const apply = (visible: boolean): void => {
      shownNow = visible;
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
    // The intersection report comes a task after the frame that shows the pane, so that frame and the next would paint
    // the screen it was paused on (#2391). A resize report runs in that frame, after layout and before the paint: a pane
    // that gains a box there is shown, and drawn at once with what waited while it was hidden.
    let boxed = wt.element.getClientRects().length > 0;
    const laidOut = new ResizeObserver(() => {
      const gained = !boxed;
      boxed = wt.element.getClientRects().length > 0;
      // Only a pane that had no box and has one now: one out of view with a box (scrolled away) is the intersection
      // observer's to report.
      if (!gained || !boxed || shownNow) return;
      apply(true);
      wt.renderNow();
    });
    laidOut.observe(wt.element);
    return () => {
      seen.disconnect();
      laidOut.disconnect();
      // A renderer mounted in its place is not shown until it is observed in turn.
      setShown(false);
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
