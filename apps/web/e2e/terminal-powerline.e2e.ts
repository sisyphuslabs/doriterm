import type { Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

/**
 * The Powerline range #1403 names: the two branch glyphs and the six separator and cap glyphs. A prompt that draws one
 * of these must get it from a face the app ships, at a size that fills its cell; a device with no face for it shows
 * tofu, and a face with different metrics leaks a gap into the next cell.
 */
const POWERLINE = ["\ue0a0", "\ue0a1", "\ue0a2", "\ue0a3", "\ue0b0", "\ue0b1", "\ue0b2", "\ue0b3"] as const;

/** `text` as printf's octal escapes, so the shell prints exactly these bytes. */
function octal(text: string): string {
  return [...new TextEncoder().encode(text)].map((byte) => `\\${byte.toString(8)}`).join("");
}

/** Prints the separators one to a row, so each row's platform faces belong to that separator alone. */
async function printSeparators(page: Page): Promise<void> {
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  const lines = POWERLINE.map(octal).join("\\n");
  await page.keyboard.type(`printf '\\033[2J\\033[H${lines}\\n'`);
  await page.keyboard.press("Enter");
  // The prompt was on screen before the print, so completion is the last separator having a row of its own.
  await expect
    .poll(
      () =>
        page.evaluate(
          (probe) => [...document.querySelectorAll(".term-row")].some((row) => row.textContent?.includes(probe)),
          "\ue0b3",
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
}

/** The ink a glyph draws in the terminal's own computed stack, and the cell it has to fill. */
async function ink(page: Page, glyph: string): Promise<{ width: number; height: number; cell: number; row: number }> {
  return page
    .locator(".term-row:not(.term-scrollback-row)")
    .first()
    .evaluate((row, text) => {
      const style = getComputedStyle(row);
      const context = document.createElement("canvas").getContext("2d");
      if (context === null) throw new Error("no canvas");
      context.font = `${style.fontSize} ${style.fontFamily}`;
      const measured = context.measureText(text);
      return {
        width: measured.actualBoundingBoxLeft + measured.actualBoundingBoxRight,
        height: measured.actualBoundingBoxAscent + measured.actualBoundingBoxDescent,
        cell: Number.parseFloat(getComputedStyle(row).getPropertyValue("--term-cell-width")),
        row: Number.parseFloat(style.lineHeight),
      };
    }, glyph);
}

/** The faces that drew the row holding `text`, as Chromium reports them, and whether each is one the page loaded. */
async function facesOf(page: Page, text: string): Promise<readonly { name: string; bundled: boolean }[]> {
  await page.evaluate((probe) => {
    const row = [...document.querySelectorAll(".term-row")].find((node) => node.textContent?.includes(probe));
    row?.setAttribute("data-probe", "");
  }, text);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "[data-probe] span" });
    const reports = await Promise.all(nodeIds.map((nodeId) => cdp.send("CSS.getPlatformFontsForNode", { nodeId })));
    return reports.flatMap(({ fonts }) => fonts.map((font) => ({ name: font.familyName, bundled: font.isCustomFont })));
  } finally {
    await page.evaluate(() => document.querySelector("[data-probe]")?.removeAttribute("data-probe"));
    await cdp.detach();
  }
}

test("every Powerline separator draws a full cell of ink in a terminal (#1403)", async ({ page }) => {
  await page.goto("/");
  await printSeparators(page);
  for (const glyph of POWERLINE) {
    // oxlint-disable-next-line no-await-in-loop -- one separator at a time, each measured in the rendered terminal
    const measured = await ink(page, glyph);
    // A tofu box is neither as wide nor as tall as a separator that fills the row; the narrowest branch glyph is still
    // more than half a cell wide, and the shortest of the eight (the right arrow head) is 0.73 of the row.
    expect(measured.width, `${JSON.stringify(glyph)} ink width`).toBeGreaterThan(measured.cell * 0.5);
    expect(measured.height, `${JSON.stringify(glyph)} ink height`).toBeGreaterThan(measured.row * 0.7);
  }
});

test("each Powerline separator comes from a face the app ships, and U+E0A3 from its own subset (#1403)", async ({
  page,
}) => {
  await page.goto("/");
  await printSeparators(page);
  for (const glyph of POWERLINE) {
    // oxlint-disable-next-line no-await-in-loop -- one separator at a time, each read once its face has loaded
    await expect
      .poll(async () => (await facesOf(page, glyph)).length, {
        message: `${JSON.stringify(glyph)} has no drawn row`,
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
    // oxlint-disable-next-line no-await-in-loop -- the faces of the row just checked
    await expect
      .poll(async () => (await facesOf(page, glyph)).filter((face) => !face.bundled).map((face) => face.name), {
        message: `${JSON.stringify(glyph)} drawn by a face the app does not ship`,
        timeout: 10_000,
      })
      .toEqual([]);
  }
  // JetBrains Mono 2.304 has E0A0-E0A2 and E0B0-E0B3 but no E0A3, and the icon face that used to fill that hole is
  // 1.2 MB. The eight-glyph subset owns it, so a prompt with a separator never fetches the icon face.
  expect((await facesOf(page, "\ue0a3")).map((face) => face.name)).toContain("Doriterm Powerline");
});

test("a terminal that draws a Powerline separator never fetches the 1.2 MB icon face (#1403)", async ({ page }) => {
  const fonts: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith(".woff2")) fonts.push(path);
  });
  await page.goto("/");
  await printSeparators(page);
  // The print is complete, so any face a separator needed has been requested.
  // The subset is 856 bytes, so Vite inlines it in the app's CSS and the worker precaches that: a separator needs no
  // font request at all. The icon face is left out of the precache, so a prompt that reached for it pays 1.2 MB.
  expect(fonts.filter((path) => path.includes("symbols-nerd-font-mono"))).toEqual([]);
});
