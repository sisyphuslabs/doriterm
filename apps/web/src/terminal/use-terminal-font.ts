import type { WTerm } from "@wterm/react";
import { useEffect } from "react";
import type { TerminalConfig } from "../ghostty/config.ts";
import { wideGlyphScaler } from "./face-scales.ts";
import { fitGrid } from "./host-size.ts";
import { applyFontMetrics } from "./font-metrics.ts";

/**
 * Applies the font's native cell grid and fallback scales again after a config, font load, or display change, and once
 * more when a view that had no layout (mounted in a tab or space not shown) is first laid out, which is when its font
 * can first be measured (#645).
 */
export function useTerminalFont(wt: WTerm | null, config: TerminalConfig): void {
  useEffect(() => {
    if (wt === null) return undefined;
    let measured = false;
    const apply = (): void => {
      measured = applyFontMetrics(wt.element);
      fitGrid(wt);
      wt.setWideGlyphScale(wideGlyphScaler(wt.element));
    };
    const shown = new ResizeObserver(() => {
      if (!measured && wt.element.getBoundingClientRect().width > 0) apply();
    });
    shown.observe(wt.element);
    // The config's stylesheet applies before the next frame.
    const frame = requestAnimationFrame(apply);
    // face-scales.ts drops its measurements on the same event, from a listener added before any view's, so this
    // re-applies with fresh ones.
    document.fonts.addEventListener("loadingdone", apply);
    window.addEventListener("resize", apply);
    return () => {
      shown.disconnect();
      cancelAnimationFrame(frame);
      document.fonts.removeEventListener("loadingdone", apply);
      window.removeEventListener("resize", apply);
    };
  }, [wt, config]);
}
