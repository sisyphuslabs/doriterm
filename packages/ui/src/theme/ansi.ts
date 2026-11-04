import { contrast, parseRgb } from "./color.ts";
import type { ResolvedTheme } from "./resolve.ts";

/** The ANSI slots programs use for coloured text: red to cyan, normal and bright (not black, white or greys). */
const TEXT_SLOTS = [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14] as const;

/**
 * The lowest contrast any ANSI text colour reaches on the theme's own terminal background. The AA guard covers the
 * terminal foreground only; ANSI colours stay as their project ships them, and Ghostty's minimum-contrast lifts them.
 */
export function ansiTextContrast(theme: ResolvedTheme): number {
  const background = parseRgb(theme.roles.background) ?? 0;
  return Math.min(...TEXT_SLOTS.map((slot) => contrast(parseRgb(theme.ansi[slot] ?? "") ?? background, background)));
}
