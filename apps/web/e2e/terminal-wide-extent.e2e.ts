import { devices, type Locator, type Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { loadKoreanFonts } from "./korean-fonts.ts";

// What a wide glyph occupies is DOM layout, not canvas metrics: its span, the advance it paints, and the ink inside it.
// The case is the one #410 reported, GeistMono Nerd Font Mono with IBM Plex Sans KR as its fallback at 16 pt with 10%
// extra cell height, where a glyph that sat narrow inside its two cells read as letter-spaced Korean.
test.use({ serviceWorkers: "block" });

const LINE =
  "\u{C548}\u{B155}\u{D558}\u{C138}\u{C694} doriface \u{D55C}\u{AE00} \u{D14C}\u{C2A4}\u{D2B8} \u{BC30}\u{D3EC}\u{C7A1} \u{D655}\u{C778} \u{BABB}\u{D55C} \u{AC83} \u{AC00}";

/** `text` typed as UTF-8 octal, so the keyboard input stays ASCII. */
const octalOf = (text: string): string =>
  [...new TextEncoder().encode(text)].map((byte) => `\\${byte.toString(8)}`).join("");

async function print(page: Page, terminal: Locator, text: string): Promise<void> {
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type(`printf '${octalOf(text)}\\n'`);
  await page.keyboard.press("Enter");
  await expect(terminal.locator(".term-row").filter({ hasText: "doriface" })).not.toHaveCount(0, { timeout: 30_000 });
}

interface WideGlyph {
  readonly text: string;
  /** The two cells the grid gives the glyph. */
  readonly box: number;
  /** The advance the browser paints for it. */
  readonly advance: number;
  /** The glyph's painted ink, in pixels. */
  readonly ink: number;
  /** How far the painted ink's centre sits from its cells' centre, in pixels. */
  readonly offCentre: number;
}

interface Extent {
  readonly cell: number;
  readonly fontSize: string;
  /** The ink height of printable ASCII in the terminal's own font: Ghostty's `asciiHeight`, its ideograph width cap. */
  readonly asciiInk: number;
  /** The advance the block's own sample glyph is drawn with, wherever its row is. */
  readonly sample: number | undefined;
  readonly wide: readonly WideGlyph[];
  readonly latin: readonly { readonly text: string; readonly cells: number }[];
}

/**
 * Every wide glyph of the printed line, measured as painted: its cells, its advance, and its ink. The ink is the
 * canvas's pixels for the same text at the size and family the span is drawn with, which is the face the browser picked.
 */
const extentOf = (element: HTMLElement): Extent => {
  const style = getComputedStyle(element);
  const cell = Number.parseFloat(style.getPropertyValue("--term-cell-width"));
  const row = [...element.querySelectorAll(".term-row")].find((each) => (each.textContent ?? "").includes("doriface"));
  if (row === undefined) throw new Error("the line with Korean text is not on screen");
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("no canvas to measure ink with");
  const ORIGIN = 80;
  const BASELINE = 170;
  const inkOf = (text: string, font: string): { readonly left: number; readonly right: number } => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.font = font;
    context.fillStyle = "#000";
    context.fillText(text, ORIGIN, BASELINE);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let left = canvas.width;
    let right = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const alpha = pixels[(y * canvas.width + x) * 4 + 3] ?? 0;
        if (alpha > 40) {
          if (x < left) left = x;
          if (x > right) right = x;
        }
      }
    }
    return { left, right };
  };
  const wide: WideGlyph[] = [];
  const latin: { text: string; cells: number }[] = [];
  let ascent = 0;
  let descent = 0;
  context.font = `${style.fontSize} ${style.fontFamily}`;
  for (let code = 0x21; code < 0x7f; code += 1) {
    const ink = context.measureText(String.fromCharCode(code));
    ascent = Math.max(ascent, ink.actualBoundingBoxAscent);
    descent = Math.max(descent, ink.actualBoundingBoxDescent);
  }
  const asciiInk = ascent + descent;
  for (const child of row.children) {
    const box = child.getBoundingClientRect();
    if (!child.classList.contains("term-wide")) {
      const text = child.textContent ?? "";
      if (text.trim() !== "") latin.push({ text, cells: Math.round(box.width / cell) });
      continue;
    }
    const drawn = getComputedStyle(child);
    const text = child.textContent ?? "";
    const ink = inkOf(text, `${drawn.fontSize} ${drawn.fontFamily}`);
    const range = document.createRange();
    range.selectNodeContents(child);
    const advance = range.getBoundingClientRect();
    const inkWidth = ink.right - ink.left + 1;
    // The canvas draws the glyph at ORIGIN, the span draws it at its advance's left edge; both measure from there.
    const inkCentre = advance.left - ORIGIN + (ink.left + ink.right) / 2;
    wide.push({
      text,
      box: box.width,
      advance: advance.width,
      ink: inkWidth,
      offCentre: inkCentre - (box.left + box.width / 2),
    });
  }
  const sampleSpan = [...element.querySelectorAll(".term-row:not(.term-scrollback-row) .term-wide")].find(
    (span) => span.textContent === "\u{AC00}",
  );
  const sample =
    sampleSpan === undefined
      ? undefined
      : (() => {
          const range = document.createRange();
          range.selectNodeContents(sampleSpan);
          return range.getBoundingClientRect().width;
        })();
  return { cell, fontSize: style.fontSize, asciiInk, sample, wide, latin };
};

/**
 * Every wide glyph is sized to Ghostty's ideograph width -- the smaller of the primary's ASCII ink height and its two
 * cells (`font/Metrics.zig`, `icWidth`) -- with its painted ink inside that box and centred in the two cells.
 */
function expectIdeographWidth(extent: Extent): void {
  const cells = 2 * extent.cell;
  const ideograph = Math.min(extent.asciiInk, cells);
  expect(extent.wide.length).toBeGreaterThanOrEqual(12);
  for (const glyph of extent.wide) {
    expect.soft(Math.abs(glyph.box - cells), `${glyph.text}: spans two cells`).toBeLessThan(0.5);
    // A pixel and a half either way: the browser hints each glyph's advance to a whole pixel, so a block fitted on one
    // sample can paint a sibling slightly short of the ideograph width.
    expect
      .soft(glyph.advance, `${glyph.text}: fills the ideograph width instead of sitting narrow inside it`)
      .toBeGreaterThan(ideograph - 1.5);
    // A face whose Hangul advances differ per syllable paints a sibling a little past the ideograph width even when the
    // block was fitted on its sample, and a block a font subset splits across two faces paints a sibling from the wider
    // face past it too (#252); this bound only catches a glyph drawn at the wrong size.
    expect.soft(glyph.advance, `${glyph.text}: sized to its two cells`).toBeLessThan(cells * 1.25);
    expect.soft(glyph.ink, `${glyph.text}: ink inside its cells`).toBeGreaterThanOrEqual(ideograph * 0.7);
    // A face's own side bearings sit inside the advance, so the ink's centre can sit a pixel or so off the cells'
    // centre however well the glyph fits; a glyph drawn without the fit is off by half a cell's worth of gap.
    expect
      .soft(Math.abs(glyph.offCentre), `${glyph.text}: ink centred in its cells`)
      .toBeLessThan(Math.max(1.5, cells / 8));
  }
  // How much of the two cells the face's ink covers: a block fitted from one sample must fill the ideograph width for
  // the whole face. A syllable whose own design is narrow (the ㅇ of 녕 leaves a margin) stays inside the average.
  const meanInk = extent.wide.reduce((sum, glyph) => sum + glyph.ink, 0) / extent.wide.length;
  expect.soft(meanInk, "the face's ink covers its ideograph width").toBeGreaterThanOrEqual(ideograph * 0.82);
  // The Latin run keeps one cell per character: fitting a wide glyph never moves ASCII text.
  for (const run of extent.latin) {
    expect.soft(run.cells, `${run.text}: one cell per character`).toBe(run.text.length);
  }
  // The block's own sample is the glyph the grid sizes, whatever face draws a given syllable of the block: its advance
  // is the ideograph width, not the whole two cells that a fallback face used to be stretched to (#647).
  if (extent.sample === undefined) throw new Error("the block's sample glyph is not on screen");
  expect
    .soft(extent.sample, "the block's sample is the ideograph width, not the whole two cells")
    .toBeLessThanOrEqual(ideograph + 1);
}

/** Settings → Terminal: the report's size, cell height and font stack. */
async function useReportedFont(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Settings" }).first().click();
  await page
    .getByRole("tab", { name: "Terminal", exact: true })
    .or(page.getByRole("button", { name: "Terminal", exact: true }))
    .first()
    .click();
  for (const [name, value] of [
    ["font-size", "16"],
    ["adjust-cell-height", "10%"],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop -- commit each setting before the next one
    await page.getByRole("textbox", { name, exact: true }).fill(value);
    // oxlint-disable-next-line no-await-in-loop -- commits this field
    await page.keyboard.press("Enter");
  }
  for (const name of ["Terminal Latin Fixture", "Terminal Korean Fixture"]) {
    // oxlint-disable-next-line no-await-in-loop -- font order is the setting under test
    await page.getByRole("button", { name: "Add font-family", exact: true }).click();
    // oxlint-disable-next-line no-await-in-loop -- the field was just added
    await page.keyboard.type(name);
    // oxlint-disable-next-line no-await-in-loop -- commits this family
    await page.keyboard.press("Enter");
  }
  await page.getByRole("button", { name: "Close settings" }).first().click();
  await expect(page.locator('[data-focused="true"] [data-terminal]')).toContainText("$", { timeout: 20_000 });
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

  test("the terminal's own fallback face fills its two cells (#410)", async ({ page }) => {
    await page.goto("/");
    const terminal = await openNewTerminal(page);
    await print(page, terminal, LINE);
    const extent = await terminal.evaluate(extentOf);
    console.log(`wide extent, terminal font: ${JSON.stringify(extent)}`);
    expectIdeographWidth(extent);
  });

  test("the reported font stack fills two cells at 16 pt with 10% extra height (#410)", async ({ page }) => {
    await page.goto("/");
    await loadKoreanFonts(page);
    await openNewTerminal(page);
    await useReportedFont(page);
    const terminal = page.locator('[data-focused="true"] [data-terminal]');
    await print(page, terminal, LINE);
    const extent = await terminal.evaluate(extentOf);
    console.log(`wide extent, reported stack: ${JSON.stringify(extent)}`);
    expectIdeographWidth(extent);
  });
});

/** Each wide glyph's ink as the WebGL canvas painted it, in CSS px across the glyph's two cells, from the canvas pixels. */
const gpuInkOf = (
  element: HTMLElement,
): readonly { readonly text: string; readonly ink: number; readonly offCentre: number }[] => {
  const canvas = element.querySelector("canvas.term-gpu-canvas:not([hidden])");
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("no WebGL canvas is showing");
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("the WebGL canvas has no 2d output");
  const row = [...element.querySelectorAll(".term-row")].find((each) => (each.textContent ?? "").includes("doriface"));
  if (row === undefined) throw new Error("the line with Korean text is not on screen");
  const frame = canvas.getBoundingClientRect();
  const scale = canvas.width / frame.width;
  const box = row.getBoundingClientRect();
  const top = Math.round((box.top - frame.top) * scale);
  const height = Math.round(box.height * scale);
  const pixels = context.getImageData(0, top, canvas.width, height).data;
  const at = (x: number, y: number): number => (y * canvas.width + x) * 4;
  // The row's last pixel is ground: the printed line ends far short of the grid's width.
  const ground = at(canvas.width - 1, Math.floor(height / 2));
  const inked = (x: number): boolean => {
    for (let y = 0; y < height; y += 1) {
      const p = at(x, y);
      const d = [0, 1, 2].reduce((sum, c) => sum + Math.abs((pixels[p + c] ?? 0) - (pixels[ground + c] ?? 0)), 0);
      if (d > 90) return true;
    }
    return false;
  };
  return [...row.querySelectorAll(".term-wide")].map((span) => {
    const cells = span.getBoundingClientRect();
    const from = Math.round((cells.left - frame.left) * scale);
    const to = Math.round((cells.right - frame.left) * scale);
    let left = -1;
    let right = -1;
    for (let x = from; x < to; x += 1) {
      if (!inked(x)) continue;
      if (left < 0) left = x;
      right = x;
    }
    const ink = left < 0 ? 0 : (right - left + 1) / scale;
    const offCentre = left < 0 ? Number.NaN : ((left + right + 1) / 2 - (from + to) / 2) / scale;
    return { text: span.textContent ?? "", ink, offCentre };
  });
};

test.describe("WebGL", () => {
  // The platform's own fallback face, as terminal-hangul-fallback.e2e.ts takes it: on a Mac the only face with Hangul
  // is proportional and narrower than two cells, which is where the WebGL atlas drew it narrow (#2810).
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, pinnedFonts: false });

  test("the WebGL canvas paints each wide glyph as the DOM row does: as wide, as centred (#2810)", async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, "platform", { value: "MacIntel" }));
    await page.goto("/");
    const terminal = await openNewTerminal(page);
    await print(page, terminal, LINE);
    await expect(terminal.locator("canvas.term-gpu-canvas:not([hidden])")).toHaveCount(1);
    const dom = (await terminal.evaluate(extentOf)).wide;
    const painted = await terminal.evaluate(gpuInkOf);
    console.log(`wide extent, WebGL against DOM: ${JSON.stringify({ dom, painted })}`);
    expect(painted.map((glyph) => glyph.text)).toEqual(dom.map((glyph) => glyph.text));
    for (const [at, glyph] of painted.entries()) {
      const row = dom[at];
      if (row === undefined) continue;
      // A pixel and a half: the canvas and the page each round the glyph's edges to whole pixels.
      expect.soft(Math.abs(glyph.ink - row.ink), `${glyph.text}: as wide as the DOM draws it`).toBeLessThanOrEqual(1.5);
      expect
        .soft(Math.abs(glyph.offCentre - row.offCentre), `${glyph.text}: centred where the DOM centres it`)
        .toBeLessThanOrEqual(1.5);
    }
  });
});

test.describe("phone", () => {
  const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
  test.use({ ...phone, serviceWorkers: "block" });

  test("a wide glyph fills its two cells on the phone too (#410)", async ({ page }) => {
    await page.goto("/");
    await loadKoreanFonts(page);
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("banner").getByRole("button", { name: "New tab" }).click();
    const terminal = page.locator("[data-terminal]").first();
    await expect(terminal).toContainText("$", { timeout: 15_000 });
    await print(page, terminal, LINE);
    const extent = await terminal.evaluate(extentOf);
    console.log(`wide extent, phone: ${JSON.stringify(extent)}`);
    expectIdeographWidth(extent);
  });
});
