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
    const seen = new IntersectionObserver((entries) => {
      const visible = entries.at(-1)?.isIntersecting ?? true;
      setShown(visible);
      pacer.setVisible(visible);
      wt.setRenderingPaused(!visible);
    });
    seen.observe(wt.element);
    return () => {
      seen.disconnect();
      // A renderer mounted in its place is not shown until it is observed in turn.
      setShown(false);
      wt.setRenderingPaused(false);
    };
  }, [wt, pacer]);
  return shown;
}
