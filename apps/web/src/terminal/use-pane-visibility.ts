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
    const seen = new IntersectionObserver((entries) => {
      const visible = entries.at(-1)?.isIntersecting ?? true;
      setShown(visible);
      pacer.setVisible(visible);
      wt.setRenderingPaused(!visible);
    });
    seen.observe(wt.element);
    return () => {
      seen.disconnect();
      wt.setRenderingPaused(false);
    };
  }, [wt, pacer]);
  return shown;
}
