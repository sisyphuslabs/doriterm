import type { TerminalStream } from "@doriface/client";
import type { WTerm } from "@wterm/react";
import { type RefObject, useEffect } from "react";
import { type AppearanceSource, appearanceStore, useActiveAppearancePalette } from "../appearance/appearance.ts";
import type { TerminalConfig } from "../ghostty/config.ts";
import { readDisplay } from "./display.ts";
import { readThemeColors } from "./theme-colors.ts";

export interface PaletteRefreshDeps {
  readonly readColors?: typeof readThemeColors;
  readonly readFacts?: typeof readDisplay;
  readonly schedule?: (run: () => void) => () => void;
  readonly appearance?: AppearanceSource;
}

const nextFrame = (run: () => void): (() => void) => {
  const frame = requestAnimationFrame(run);
  return () => cancelAnimationFrame(frame);
};

/**
 * Refreshes a mounted terminal's inline palette, libghostty colour table, and core display facts in place whenever the
 * terminal config, the active Appearance palette, or the system's light/dark scheme changes. The previously set inline
 * colours are cleared first so they cannot shadow the page's updated variables or config overrides; layout refits stay
 * in `useTerminalFont` so palette-only changes avoid unnecessary layout work.
 */
export function useTerminalPalette(
  wt: WTerm | null,
  config: TerminalConfig,
  dark: boolean,
  stream: RefObject<TerminalStream | null>,
  deps: PaletteRefreshDeps = {},
): void {
  const {
    readColors = readThemeColors,
    readFacts = readDisplay,
    schedule = nextFrame,
    appearance = appearanceStore,
  } = deps;
  const palette = useActiveAppearancePalette(dark, appearance);
  useEffect(() => {
    if (wt === null) return undefined;
    return schedule(() => {
      wt.setThemeColors(null);
      const colors = readColors(wt.element);
      if (colors !== null) wt.setThemeColors(colors);
      stream.current?.facts(readFacts(wt.element));
    });
  }, [wt, config, dark, palette, stream, readColors, readFacts, schedule]);
}
