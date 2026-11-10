import type { Locator, Page } from "@playwright/test";
import { join } from "node:path";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { loadKoreanFonts } from "./korean-fonts.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

const LINE = "A 한글 tail B";

async function koreanTerminal(page: Page): Promise<Locator> {
  await page.addInitScript(() => Object.defineProperty(navigator, "platform", { value: "MacIntel" }));
  await page.goto("/");
  await loadKoreanFonts(page);
  await openNewTerminal(page);
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
  const terminal = page.locator('[data-focused="true"] [data-terminal]');
  await expect(terminal).toContainText("$");
  const octal = [...new TextEncoder().encode(LINE)].map((byte) => `\\${byte.toString(8)}`).join("");
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type(`printf '\\033[2J\\033[H${octal}\\n'; PS1='$ '`);
  await page.keyboard.press("Enter");
  await expect(terminal.locator(".term-row").filter({ hasText: LINE })).toHaveCount(1);
  return terminal;
}

test("a configured Korean fallback is drawn at the ideograph width #410 gives it, centred at 16 pt and 10% extra height", async ({
  page,
}) => {
  const terminal = await koreanTerminal(page);
  const glyphs = terminal.locator(".term-wide").filter({ hasText: /^[한글]$/u });
  await expect(glyphs).toHaveCount(2);
  const ink = await glyphs.evaluateAll((nodes) =>
    nodes.map((node) => {
      const style = getComputedStyle(node);
      const context = document.createElement("canvas").getContext("2d");
      if (context === null) throw new Error("No canvas");
      context.font = `${style.fontSize} ${style.fontFamily}`;
      const metrics = context.measureText(node.textContent ?? "");
      const range = document.createRange();
      range.selectNodeContents(node);
      const text = range.getBoundingClientRect();
      const cell = node.getBoundingClientRect();
      const root = node.closest("[data-terminal]") ?? node;
      const rootStyle = getComputedStyle(root);
      context.font = `${rootStyle.fontSize} ${rootStyle.fontFamily}`;
      let ascent = 0;
      let descent = 0;
      for (let code = 0x21; code < 0x7f; code++) {
        const ascii = context.measureText(String.fromCharCode(code));
        ascent = Math.max(ascent, ascii.actualBoundingBoxAscent);
        descent = Math.max(descent, ascii.actualBoundingBoxDescent);
      }
      return {
        coverage: (metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight) / cell.width,
        centre: (text.left - metrics.actualBoundingBoxLeft + text.left + metrics.actualBoundingBoxRight) / 2,
        cellCentre: (cell.left + cell.right) / 2,
        advance: text.width,
        box: cell.width,
        // Ghostty sizes a fallback face to min(asciiHeight, two cells), not to the two cells (#410).
        ideograph: Math.min(ascent + descent, cell.width),
      };
    }),
  );
  for (const measured of ink) {
    // #410 sizes the face to the ideograph width, so 80% of that width is the fill the rule promises. The old "80% of
    // the two cells" held only where Linux rounds the ASCII ink box out to whole pixels, pushing the cap to ~83% of the
    // cells; with exact ink metrics the cap here is 15.39 px against a 20 px box, so no face may draw 16 px (#862).
    expect
      .soft(Math.abs(measured.advance - measured.ideograph), "the fallback is drawn at its ideograph width")
      .toBeLessThanOrEqual(1);
    expect
      .soft(measured.coverage, "the fallback's ink fills the width it is given")
      .toBeGreaterThanOrEqual((0.8 * measured.ideograph) / measured.box);
    expect.soft(Math.abs(measured.centre - measured.cellCentre)).toBeLessThan(1);
  }
  const dir = process.env["FONT_SCREENSHOT_DIR"];
  if (dir !== undefined) await page.screenshot({ path: join(dir, "terminal-korean-glyph-1440.png") });
});
