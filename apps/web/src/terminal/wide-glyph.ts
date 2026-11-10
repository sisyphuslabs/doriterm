/** The terminal font's metrics a wide glyph is sized against, in CSS pixels. */
export interface PrimaryMetrics {
  /** One cell: the advance of an ASCII glyph. */
  readonly cell: number;
  /** The ink height of the printable ASCII glyphs, which Ghostty calls `asciiHeight`. */
  readonly inkHeight: number;
}

/** Rounded down, so the style string stays stable and never asks for more than was measured. */
const rounded = (scale: number): number => Math.floor(scale * 10_000) / 10_000;

/**
 * The smallest factor a measurement is believed for. A CJK face's ideograph is about one em and the ideograph width is
 * about the ASCII ink height, so a real fit lands near 1; a factor under one half says the measurement does not describe
 * the face that draws, and following it paints the glyph as a speck or as nothing (#959).
 */
const MIN_SCALE = 0.5;

/**
 * The font-size factor that gives a fallback face's wide glyphs the width Ghostty gives them;
 * `advanceAt(scale)` is the advance of a full-width sample glyph of that face at `scale` times the terminal's size.
 *
 * Ghostty sizes a fallback face to its ideograph width, `min(asciiHeight, two cells)` (`font/Metrics.zig`, `icWidth`),
 * not to the two cells alone: filling the whole wide cell draws Hangul a third larger than the Latin beside it, and a
 * face that draws wide glyphs wider than the primary's ink height stands out as too large and too thin (#410).
 *
 * A full-width sample sizes the whole fallback face to that width. A sample that already fills it, or is no wider than
 * one cell (a missing glyph), keeps its size. A grid with no layout to measure — a pane in a background tab reports a
 * cell of zero — keeps the size too, rather than sizing every glyph to nothing.
 *
 * A browser that rounds advances to whole pixels (Chromium on Linux) can draw the scaled glyph wider than the target,
 * past its cells, so the factor shrinks until the advance it actually draws fits.
 *
 * A measure that never fits at any factor, or fits only below MIN_SCALE, did not follow the font size: the glyph keeps
 * its size and draws a little past its cells, never at no size. An Android tablet drew every Hangul cell blank that way,
 * each at `font-size:0em` (#959).
 */
export function wideGlyphScale(advanceAt: (scale: number) => number, primary: PrimaryMetrics): number {
  const advance = advanceAt(1);
  const cells = 2 * primary.cell;
  if (!Number.isFinite(advance) || advance <= 0) return 1;
  if (!Number.isFinite(cells) || !(cells > 0)) return 1;
  const target = primary.inkHeight > 0 ? Math.min(primary.inkHeight, cells) : cells;
  if (!(advance > primary.cell) || (advance <= target && target - advance < 0.5)) return 1;
  const scale = rounded(target / advance);
  if (scale < MIN_SCALE) return 1;
  if (advanceAt(scale) <= target) return scale;
  // Proportional corrections can remain on the same rounded-up pixel for many iterations. Search the monotonic
  // advance instead; 16 steps resolve better than the four decimal places retained in the CSS factor.
  let low = 0;
  let high = scale;
  for (let step = 0; step < 16; step++) {
    const middle = (low + high) / 2;
    if (advanceAt(middle) <= target) low = middle;
    else high = middle;
  }
  const fitted = rounded(low);
  return fitted >= MIN_SCALE && advanceAt(fitted) <= target ? fitted : 1;
}

type GlyphInk = Pick<TextMetrics, "width" | "actualBoundingBoxAscent" | "actualBoundingBoxDescent">;

/** The cell is the primary W's advance; the ink height is Ghostty's `asciiHeight`, the bounding box of printable ASCII. */
export function primaryMetrics(context: { measureText(text: string): GlyphInk }): PrimaryMetrics {
  let ascent = 0;
  let descent = 0;
  for (let code = 0x21; code < 0x7f; code++) {
    const ink = context.measureText(String.fromCharCode(code));
    ascent = Math.max(ascent, ink.actualBoundingBoxAscent);
    descent = Math.max(descent, ink.actualBoundingBoxDescent);
  }
  return { cell: context.measureText("W").width, inkHeight: ascent + descent };
}
