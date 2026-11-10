import { describe, expect, test } from "bun:test";
import { primaryMetrics, wideGlyphScale } from "./wide-glyph.ts";

// A 10.40625 px cell owns a 20.8125 px wide advance; this ASCII ink is as tall as those two cells, so the grid caps it.
const jetbrains = { cell: 10.406_25, inkHeight: 20.8125 };

/** JetBrains Mono's ASCII ink is 0.967 em, shorter than its two cells: Ghostty's ideograph width is that ink. */
const capped = { cell: 10.406_25, inkHeight: 20.1 };

/** A face whose advance grows with its size, as a browser lays it out with subpixel advances. */
const linear = (advance: number) => (scale: number) => advance * scale;

// Chromium on Linux: 10 px cells, ASCII ink 20 px, NanumGothic Hangul 16 px; at 1.25x it draws 21 px, not 20.
const whole = (scale: number) => Math.ceil(16 * scale + 0.4);

describe("wideGlyphScale", () => {
  test("a fallback face narrower than the ideograph width grows to it, as Ghostty sizes it", () => {
    // Apple SD Gothic Neo draws Hangul with a 15 px advance at that size.
    expect(15 * wideGlyphScale(linear(15), jetbrains)).toBeCloseTo(20.8125, 2);
  });

  test("the ideograph width is the smaller of the ASCII ink height and the two cells, as Ghostty takes it (#410)", () => {
    expect(15 * wideGlyphScale(linear(15), capped)).toBeCloseTo(20.1, 2);
    expect(23 * wideGlyphScale(linear(23), capped)).toBeCloseTo(20.1, 2);
  });

  test("the ideograph width follows two primary cells when the ASCII ink is taller than them", () => {
    const tall = { cell: 8, inkHeight: 20 };
    expect(17 * wideGlyphScale(linear(17), tall)).toBeCloseTo(16, 2);
  });

  test("where advances round up to whole pixels, the glyph is shrunk until the advance drawn fits the cells", () => {
    const scale = wideGlyphScale(whole, { cell: 10, inkHeight: 20 });
    expect(whole(scale)).toBe(20);
  });

  test("whole-pixel advances fit a fractional two-cell boundary without stopping on a rounded-up pixel", () => {
    const scale = wideGlyphScale(whole, { cell: 10.43, inkHeight: 21 });
    expect(whole(scale)).toBe(20);
  });

  test.each([
    ["fills its two cells (a font made for the grid)", 20.8125],
    ["is within half a pixel of two cells", 20.5],
    ["is no wider than one cell", 10],
    ["has no advance", 0],
    ["has an advance that is not a number", Number.NaN],
  ])("a glyph that %s keeps its size", (_why, advance) => {
    expect(wideGlyphScale(linear(advance), jetbrains)).toBe(1);
  });

  // #959: an Android tablet drew every Hangul cell blank, column alignment intact. A factor of 0 is `font-size:0em`.
  test.each([
    ["one advance at every size, as a canvas that does not follow the font size", () => 16],
    ["no number once scaled", (scale: number) => (scale === 1 ? 16 : Number.NaN)],
    [
      "an advance that stops shrinking above the cells, as a face drawn from fixed sizes",
      (scale: number) => Math.max(16 * scale, 14),
    ],
    ["an advance far past any face's, so fitting it would shrink the glyph to a speck", linear(200)],
  ])("a measure that gives %s keeps the glyph at its own size, never at nothing (#959)", (_why, advanceAt) => {
    expect(wideGlyphScale(advanceAt, { cell: 8.4, inkHeight: 13 })).toBe(1);
  });

  test.each([
    ["a pane in a background tab, with no box", 0],
    ["a cell that is not a number", Number.NaN],
    ["a negative cell", -10],
  ])("%s keeps every wide glyph at its own size, never at nothing", (_what, cell) => {
    expect(wideGlyphScale(linear(15), { cell, inkHeight: 20 })).toBe(1);
    expect(wideGlyphScale(linear(15), { cell, inkHeight: 20 })).not.toBe(0);
  });
});

describe("primaryMetrics", () => {
  test("the cell is the primary W's advance and the ink height is printable ASCII's, as Ghostty measures it", () => {
    const ink: Record<string, { ascent: number; descent: number }> = {
      W: { ascent: 10, descent: 0 },
      j: { ascent: 9, descent: 4 },
    };
    const context = {
      measureText: (text: string) => {
        const glyph = ink[text] ?? { ascent: 12, descent: 1 };
        return {
          width: text === "W" ? 9.5 : 7,
          actualBoundingBoxAscent: glyph.ascent,
          actualBoundingBoxDescent: glyph.descent,
        };
      },
    };
    expect(primaryMetrics(context)).toEqual({ cell: 9.5, inkHeight: 16 });
  });
});
