import { cn } from "../lib/cn.ts";

/**
 * Text inside an overlay breaks anywhere once a word is too long for the line, so an unbroken name (a path, a URL,
 * a long session name) wraps inside the box instead of running past it and off the screen (#152). Korean breaks at
 * spaces, not between the syllables of a word (keep-all); a Korean word longer than the line still breaks anywhere.
 * Both are inherited, so they reach every caller's text too; a text that truncates keeps its ellipsis.
 */
export const wrapAnywhere = "[overflow-wrap:anywhere] break-keep";

/** The one overlay level: popover tone, hairline, a single shadow, 120 ms scale-fade from its origin; text wraps anywhere. */
export const overlaySurface = cn(
  wrapAnywhere,
  "rounded-lg border border-border bg-popover text-popover-foreground shadow-overlay outline-none",
  "origin-(--transform-origin) transition-[opacity,transform] duration-(--duration-micro) ease-out",
  "data-starting-style:scale-[0.97] data-starting-style:opacity-0 data-ending-style:scale-[0.97] data-ending-style:opacity-0",
);

/**
 * An anchored popup (tooltip, popover, menu) is never wider than the room the viewport leaves it beside its anchor:
 * Base UI's positioner measures that as --available-width, as it measures --available-height for #248.
 */
export const fitsViewportWidth = "max-w-(--available-width)";

/**
 * A modal's backdrop and popup sit above everything in the page, so nothing under them takes a click meant for them:
 * a split's pane divider is `z-10` in the workspace (#321).
 */
export const modalLayer = "z-50";

const backdropBase = cn(
  modalLayer,
  "fixed inset-0 bg-black/40 transition-opacity",
  "data-starting-style:opacity-0 data-ending-style:opacity-0",
);

export const backdropClass = cn(backdropBase, "duration-(--duration-standard)");

export const sheetBackdropClass = cn(
  backdropBase,
  "duration-(--duration-sheet-in) data-ending-style:duration-(--duration-sheet-out)",
);
