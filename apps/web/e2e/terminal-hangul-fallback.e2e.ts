import type { Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";

// The default stack, with no Korean font injected: this is the path a macOS user takes, where the only face that
// covers Hangul is a proportional one. Every other Korean e2e loads its own Plex subset, so none of them can see it.
test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

const LINE = "A 한글 tail B";
const HANGUL = /^[한글]$/u;

const octalOf = (text: string): string =>
  [...new TextEncoder().encode(text)].map((byte) => `\\${byte.toString(8)}`).join("");

async function hangulTerminal(page: Page): Promise<Locator> {
  await page.addInitScript(() => Object.defineProperty(navigator, "platform", { value: "MacIntel" }));
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type(`printf '\\033[2J\\033[H${octalOf(LINE)}\\n'`);
  await page.keyboard.press("Enter");
  await expect(terminal.locator(".term-row").filter({ hasText: LINE })).toHaveCount(1, { timeout: 30_000 });
  return terminal;
}

interface Metrics {
  readonly cell: number;
  readonly asciiInk: number;
  readonly wide: readonly {
    readonly text: string;
    readonly box: number;
    readonly ink: number;
    readonly fill: number;
    readonly painted: number;
  }[];
  readonly latin: { readonly ink: number; readonly fill: number; readonly painted: number };
}

const metricsOf = (terminal: Locator): Promise<Metrics> =>
  terminal.evaluate((root) => {
    const row = root.querySelector(".term-row");
    if (row === null) throw new Error("no row");
    const wide = [...row.querySelectorAll(".term-wide")];
    const sample = wide[0] ?? row.children[0];
    if (sample === undefined) throw new Error("no sample");
    const cell = Number.parseFloat(getComputedStyle(root).getPropertyValue("--term-cell-width"));
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context === null) throw new Error("no canvas to measure ink with");
    const ORIGIN = 12;
    const BASELINE = 44;
    const inkOf = (
      text: string,
      font: string,
    ): { readonly height: number; readonly width: number; readonly painted: number } => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.font = font;
      context.fillStyle = "#000";
      context.fillText(text, ORIGIN, BASELINE);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let top = canvas.height;
      let bottom = -1;
      let left = canvas.width;
      let right = -1;
      let painted = 0;
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          const alpha = pixels[(y * canvas.width + x) * 4 + 3] ?? 0;
          if (alpha > 40) {
            painted += 1;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
            if (x < left) left = x;
            if (x > right) right = x;
          }
        }
      }
      const height = bottom < top ? 0 : bottom - top + 1;
      const width = right < left ? 0 : right - left + 1;
      return { height, width, painted };
    };
    const latinSample = row.children[0] ?? sample;
    const latinStyle = getComputedStyle(latinSample);
    const latinFont = `${latinStyle.fontSize} ${latinStyle.fontFamily}`;
    let ascent = 0;
    let descent = 0;
    for (let code = 0x21; code < 0x7f; code += 1) {
      context.font = latinFont;
      const ink = context.measureText(String.fromCharCode(code));
      ascent = Math.max(ascent, ink.actualBoundingBoxAscent);
      descent = Math.max(descent, ink.actualBoundingBoxDescent);
    }
    return {
      cell,
      asciiInk: ascent + descent,
      wide: wide.map((node) => {
        const drawn = getComputedStyle(node);
        const measured = inkOf(node.textContent ?? "", `${drawn.fontSize} ${drawn.fontFamily}`);
        return {
          text: node.textContent ?? "",
          box: node.getBoundingClientRect().width,
          ink: measured.height,
          fill: measured.width,
          painted: measured.painted,
        };
      }),
      latin: (() => {
        const measured = inkOf("H", latinFont);
        return { ink: measured.height, fill: measured.width, painted: measured.painted };
      })(),
    };
  });

test("a committed Hangul syllable paints the ink height of the Latin beside it (#1245)", async ({ page }) => {
  const terminal = await hangulTerminal(page);
  await expect(terminal.locator(".term-wide").filter({ hasText: HANGUL })).toHaveCount(2);
  const metrics = await metricsOf(terminal);
  expect(metrics.wide.length).toBeGreaterThanOrEqual(2);
  expect(metrics.asciiInk).toBeGreaterThan(0);
  const latinDensity = metrics.latin.painted / (metrics.latin.fill * metrics.latin.ink);
  for (const glyph of metrics.wide) {
    const where = `${glyph.text}: box ${glyph.box}px, ink ${glyph.ink}px by ${glyph.fill}px, ${glyph.painted} painted`;
    expect(glyph.box, `${glyph.text} spans two cells`).toBeCloseTo(metrics.cell * 2, 0);
    expect(glyph.ink / metrics.asciiInk, `${where} against Latin ink ${metrics.asciiInk}px`).toBeGreaterThanOrEqual(
      0.8,
    );
    expect(glyph.fill / glyph.box, `${where} fills its cells`).toBeGreaterThanOrEqual(0.8);
    const density = glyph.painted / (glyph.fill * glyph.ink);
    expect(density, `${where} against Latin density ${latinDensity.toFixed(3)}`).toBeGreaterThan(0);
  }
});

/** Composes `text` in the focused terminal's field and expects its box to span `cells` cells, then commits it. */
async function expectComposingCells(page: Page, terminal: Locator, text: string, cells: number): Promise<void> {
  const field = terminal.getByRole("textbox");
  await field.focus();
  const cell = await terminal.evaluate((root) =>
    Number.parseFloat(getComputedStyle(root).getPropertyValue("--term-cell-width")),
  );
  expect(cell).toBeGreaterThan(0);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
  await expect
    .poll(async () => (await field.boundingBox())?.width ?? 0, {
      message: `the box composing ${JSON.stringify(text)} spans ${cells} cells of ${cell}px`,
      timeout: 5_000,
    })
    .toBeCloseTo(cell * cells, 0);
  await cdp.send("Input.insertText", { text });
  await cdp.detach();
}

/** Narrows every cell by `px` through adjust-cell-width, so a glyph's own advance is wider than its cells. */
async function narrowCells(page: Page, px: number): Promise<Locator> {
  await page.getByRole("link", { name: "Settings" }).first().click();
  await page
    .getByRole("tab", { name: "Terminal" })
    .or(page.getByRole("button", { name: "Terminal" }))
    .first()
    .click();
  await page.getByRole("textbox", { name: "adjust-cell-width" }).fill(String(px));
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Close settings" }).first().click();
  const focused = page.locator('[data-focused="true"] [data-terminal]');
  await expect
    .poll(() =>
      focused
        .locator(".term-row")
        .first()
        .evaluate((row) => Number.parseFloat(getComputedStyle(row).letterSpacing)),
    )
    .toBeLessThan(px / 2);
  return focused;
}

test("the composing box spans the two cells a wide syllable takes (#1245)", async ({ page }) => {
  await expectComposingCells(page, await hangulTerminal(page), "한", 2);
});

test("the composing box spans one cell per Latin letter of a preedit, as the grid draws them (#1245)", async ({
  page,
}) => {
  await expectComposingCells(page, await hangulTerminal(page), "ni", 2);
});

test("a syllable composed as conjoining jamo spans its two cells: the vowel and final take none (#1245)", async ({
  page,
}) => {
  await expectComposingCells(page, await hangulTerminal(page), "\u1112\u1161\u11ab", 2);
});

// Characters at the edges of the width table's ranges: a Yijing hexagram (which the grid draws over two cells, as
// Unicode 16 made them wide), a CJK ideograph, emoji with text presentation (one cell) and emoji with emoji presentation
// (two cells), and text-presentation emoji with VS16, which asks for the picture (two cells). The test reads each one's
// width from the grid and checks the composing box spans the same.
const WIDTH_PROBES = [
  "\u{4DC0}",
  "\u{4E00}",
  "\u{1F300}",
  "\u{1F321}",
  "\u{1F32C}",
  "\u{1F680}",
  "\u{1F321}\uFE0F",
  "\u{1F5A5}\uFE0F",
  "\u{1F336}\uFE0F",
  "\u{1F54A}\uFE0F",
];

test("the composing box spans the cells the grid gives each character, wide or not (#1285)", async ({ page }) => {
  const terminal = await hangulTerminal(page);
  await page.keyboard.type(
    `printf '\\033[2J\\033[H${WIDTH_PROBES.map((probe) => `[${octalOf(probe)}]`).join("\\n")}\\n'`,
  );
  await page.keyboard.press("Enter");
  const rows = terminal.locator(".term-row");
  for (const probe of WIDTH_PROBES) {
    // oxlint-disable-next-line no-await-in-loop -- each probe's row is read once the shell has printed it
    await expect(rows.filter({ hasText: `[${probe}]` })).toHaveCount(1, { timeout: 30_000 });
  }
  const gridCells = await terminal.evaluate(
    (root, probes) =>
      probes.map((probe) => {
        const row = [...root.querySelectorAll(".term-row")].find((each) => each.textContent?.includes(`[${probe}]`));
        const wide = [...(row?.querySelectorAll(".term-wide") ?? [])].some((each) => each.textContent === probe);
        return wide ? 2 : 1;
      }),
    WIDTH_PROBES,
  );
  for (const [index, probe] of WIDTH_PROBES.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- one composition at a time in the one field
    await expectComposingCells(page, terminal, probe, gridCells[index] ?? 0);
  }
});

test("with cells narrowed by adjust-cell-width, the composing box still spans the cells the grid gives (#1245)", async ({
  page,
}) => {
  await hangulTerminal(page);
  const terminal = await narrowCells(page, -3);
  await expectComposingCells(page, terminal, "한", 2);
  await expectComposingCells(page, terminal, "ni", 2);
});
