import type { Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { pressShortcut } from "./platform-keys.ts";
import { loadFixtureFont } from "./font-fixture.ts";

test.use({ serviceWorkers: "block" });

/** Ghostty's points as CSS pixels on the platform the page runs on: 1:1 on Apple platforms, 96/72 elsewhere. */
const cssPixels = async (page: Page, points: number): Promise<number> =>
  points * ((await page.evaluate(() => /Mac|iPhone|iPad|iPod/i.test(navigator.platform))) ? 1 : 96 / 72);

/** Layout positions are in 1/64 CSS-pixel units. */
const layoutUnits = (px: number): number => Math.round(px * 64) / 64;

/** The fixture's own advance for W at `px`, laid out by this platform in a plain span: what the cell is built from. */
const fixtureAdvance = (page: Page, px: number): Promise<number> =>
  page.evaluate((size) => {
    const span = document.createElement("span");
    span.style.cssText = `position:absolute;white-space:pre;font:${size}px "Terminal PUA Fixture"`;
    span.textContent = "W";
    document.body.append(span);
    const width = span.getBoundingClientRect().width;
    span.remove();
    return width;
  }, px);

async function configure(page: Page, families: readonly string[]): Promise<Locator> {
  await page.getByRole("link", { name: "Settings" }).first().click();
  await page
    .getByRole("tab", { name: "Terminal", exact: true })
    .or(page.getByRole("button", { name: "Terminal", exact: true }))
    .first()
    .click();
  await page.getByRole("textbox", { name: "font-size", exact: true }).fill("16");
  await page.keyboard.press("Enter");
  for (const family of families) {
    // oxlint-disable-next-line no-await-in-loop -- repeated font-family entries preserve their order
    await page.getByRole("button", { name: "Add font-family", exact: true }).click();
    // oxlint-disable-next-line no-await-in-loop -- the next field exists only after this one commits
    await page.keyboard.type(family);
    // oxlint-disable-next-line no-await-in-loop -- commits this family
    await page.keyboard.press("Enter");
  }
  await page.getByRole("button", { name: "Close settings" }).first().click();
  const terminal = page.locator('[data-focused="true"] [data-terminal]');
  await expect(terminal).toContainText("$");
  return terminal;
}

for (const dpr of [1, 2, 1.5]) {
  test(`16 Ghostty points use this platform's native glyph and cell metrics at DPR ${dpr}, and zoom applies live`, async ({
    page,
  }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: dpr,
      mobile: false,
    });
    await page.goto("/");
    await loadFixtureFont(page);
    await openNewTerminal(page);
    const terminal = await configure(page, ["Terminal PUA Fixture"]);
    const geometry = () =>
      terminal.evaluate((element) => {
        const style = getComputedStyle(element);
        const row = element.querySelector(".term-row");
        const context = document.createElement("canvas").getContext("2d");
        if (context === null) throw new Error("No canvas");
        context.font = `${style.fontSize} ${style.fontFamily}`;
        const ink = context.measureText("W");
        return {
          size: parseFloat(style.fontSize),
          height: ink.actualBoundingBoxAscent + ink.actualBoundingBoxDescent,
          cell: parseFloat(style.getPropertyValue("--term-cell-width")),
          row: row?.getBoundingClientRect().height,
        };
      });
    // Independent font design metrics: 900/1000 advance, 800/1000 ink height, 1000/1000 line height.
    const px = await cssPixels(page, 16);
    await expect.poll(async () => (await geometry()).size).toBeCloseTo(px, 3);
    const measured = await geometry();
    // Linux Chromium rounds a glyph's ink box out to whole pixels, its top and bottom apiece (so by up to one pixel);
    // macOS reports it exactly. Another face's W would differ by several pixels at this size.
    expect(Math.abs(measured.height - px * 0.8)).toBeLessThanOrEqual(1);
    // The cell is the font's advance on this platform, rounded to device pixels; a fractional device pixel (DPR 1.5) is
    // stored to the nearer 1/64 px layout unit either way, so one unit of slack.
    const advance = await fixtureAdvance(page, measured.size);
    expect(Math.abs(measured.cell - Math.round(advance * dpr) / dpr)).toBeLessThanOrEqual(1 / 64);
    expect(measured.row).toBe(layoutUnits(Math.round(px * dpr) / dpr));
    const mounted = await terminal.elementHandle();
    await terminal.getByRole("textbox").focus();
    await pressShortcut(page, "app.zoom_in");
    const bigger = await cssPixels(page, 17);
    await expect.poll(async () => (await geometry()).size).toBeCloseTo(bigger, 3);
    expect(await mounted?.evaluate((element) => element.isConnected)).toBe(true);
  });
}

test("quoted configured families draw BMP and supplementary PUA glyphs through the font list (#387)", async ({
  page,
}) => {
  await page.goto("/");
  await loadFixtureFont(page);
  await openNewTerminal(page);
  const terminal = await configure(page, ["Missing terminal test font", "'Terminal PUA Fixture'"]);
  const icons = "\ue0b0\uf015\uf07b\u{f0001}";
  const octal = [...new TextEncoder().encode(icons)].map((byte) => `\\${byte.toString(8)}`).join("");
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type(`printf '${octal}\\n'`);
  await page.keyboard.press("Enter");
  const spans = terminal
    .locator(".term-row:not(.term-scrollback-row) span")
    .filter({ hasText: /^[\ue0b0\uf015\uf07b\u{f0001}]$/u });
  await expect(spans).toHaveCount(4);
  const drawn = await spans.evaluateAll((nodes) =>
    nodes.map((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const style = getComputedStyle(node);
      const spacing = style.letterSpacing === "normal" ? 0 : parseFloat(style.letterSpacing);
      return { advance: range.getBoundingClientRect().width - spacing, size: parseFloat(style.fontSize) };
    }),
  );
  // Every fixture glyph shares W's 0.9 em advance, laid out as this platform lays it out; a fallback or tofu face's
  // advance differs from it by far more than a layout unit.
  for (const { advance, size } of drawn) {
    // oxlint-disable-next-line no-await-in-loop -- one reference per glyph's own size
    expect(Math.abs(advance - (await fixtureAdvance(page, size)))).toBeLessThanOrEqual(1 / 64);
  }
});
