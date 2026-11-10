import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { visibleCharacters } from "./sidebar-measure.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const FONT = '400 32px "E2E UI", sans-serif';
// The pinned face's W is wider than its ellipsis, so the W placed at the cut can be followed by one that overflows.
const TEXT = "AWW";

interface Probe {
  /** The right edge of every grapheme, from the layout, while the element still holds all of its text. */
  readonly rights: readonly number[];
  /** The advance of the ellipsis in the same face. */
  readonly ellipsis: number;
}

/** A one-line probe in the pinned UI face, at its natural width, with the right edge of every grapheme and of "…". */
const probe = (page: Page, content: string): Promise<Probe> =>
  page.evaluate(
    async ({ text, font }) => {
      const element = document.createElement("div");
      element.id = "measure-probe";
      element.textContent = text;
      Object.assign(element.style, {
        position: "absolute",
        top: "0",
        left: "0",
        margin: "0",
        padding: "0",
        border: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        font,
      });
      document.body.append(element);
      await document.fonts.load(font, text);
      const node = element.firstChild;
      if (!(node instanceof Text)) throw new Error("the probe has no text");
      const range = document.createRange();
      const rights = [...text].map((_, index) => {
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        return range.getBoundingClientRect().right;
      });
      const pen = document.createElement("canvas").getContext("2d");
      if (pen === null) throw new Error("the probe has no 2d context");
      pen.font = getComputedStyle(element).font;
      return { rights, ellipsis: pen.measureText("\u2026").width };
    },
    { text: content, font: FONT },
  );

/** Narrows the probe to `width`, and says whether the whole-pixel widths the old helper compared still agree. */
const narrowTo = (page: Page, width: number): Promise<{ readonly sameWholePixelWidths: boolean }> =>
  page.evaluate((pixels) => {
    const element = document.getElementById("measure-probe");
    if (element === null) throw new Error("the probe is gone");
    element.style.width = `${pixels}px`;
    return { sameWholePixelWidths: element.scrollWidth === element.clientWidth };
  }, width);

const count = async (page: Page, text: string): Promise<{ readonly visible: number; readonly total: number }> => {
  const { visible, total } = await visibleCharacters(page.locator("#measure-probe"), text);
  return { visible, total };
};

test("a glyph that ends a quarter pixel past the ellipsis is not counted as drawn", async ({ page }) => {
  await page.goto("/");
  const { rights, ellipsis } = await probe(page, TEXT);
  const hidden = rights[1];
  if (hidden === undefined) throw new Error("the probe does not have three graphemes");
  // The first W ends 0.25 px after the ellipsis starts, inside the old half-pixel window: Chromium draws "A…", and both
  // Ws are hidden by it.
  await narrowTo(page, hidden + ellipsis - 0.25);
  expect(await count(page, TEXT), "only A is drawn before the ellipsis").toEqual({ visible: 1, total: 3 });
});

test("a sub-pixel overflow the whole-pixel widths miss still hides the last glyph", async ({ page }) => {
  await page.goto("/");
  const { rights } = await probe(page, TEXT);
  const last = rights[2];
  if (last === undefined) throw new Error("the probe does not have three graphemes");
  // The last W ends a quarter pixel past the box: an overflow Chromium cuts, but the integer widths miss.
  const narrowed = await narrowTo(page, last - 0.25);
  expect(narrowed.sameWholePixelWidths, "the old whole-pixel check would see no cut").toBe(true);
  expect(await count(page, TEXT), "only AW is drawn before the ellipsis").toEqual({ visible: 2, total: 3 });
});
