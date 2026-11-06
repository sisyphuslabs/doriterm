import type { Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const HANGUL_FAMILIES = [
  "Noto Sans Mono CJK KR",
  "Noto Sans Mono CJK JP",
  "Noto Sans CJK KR",
  "Noto Sans KR",
  "Nanum Gothic Coding",
  "Malgun Gothic",
  "Apple SD Gothic Neo",
];

test("the terminal font stack names a Hangul face, so a device without the Latin ones still draws Korean (#959)", async ({
  page,
}) => {
  await page.goto("/");
  await openNewTerminal(page);
  const stack = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-term"));
  expect(HANGUL_FAMILIES.filter((family) => stack.includes(family))).not.toHaveLength(0);
});

/**
 * The reported failure is a cell that paints nothing, so the test counts the pixels the cell actually marks: an advance
 * width cannot answer this (a codepoint with no glyph still reports one), and a canvas cannot either (a browser paints a
 * tofu box for a missing glyph, which is ink).
 *
 * Both crops go through the same page.screenshot with INTEGER bounds. An element screenshot rounds its box outward while
 * a clip honours its fractional values, so mixing the two yields images of different size even when both cells are empty
 * - a byte comparison between them then passes on a blank cell and guards nothing.
 */
type Ink = { readonly ink: number; readonly width: number; readonly height: number };

async function cropInk(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<Ink> {
  const shot = await page.screenshot({ clip });
  return page.evaluate(async (base64: string): Promise<Ink> => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.codePointAt(0) ?? 0);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("the page has no 2d context");
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const red = data[0] ?? 0;
    const green = data[1] ?? 0;
    const blue = data[2] ?? 0;
    let ink = 0;
    for (let index = 0; index < data.length; index += 4) {
      const distance =
        Math.abs((data[index] ?? 0) - red) +
        Math.abs((data[index + 1] ?? 0) - green) +
        Math.abs((data[index + 2] ?? 0) - blue);
      if (distance > 24) ink += 1;
    }
    return { ink, width: bitmap.width, height: bitmap.height };
  }, shot.toString("base64"));
}

async function syllableInk(page: Page, terminal: Locator): Promise<{ readonly glyph: Ink; readonly blank: Ink }> {
  await terminal.getByRole("textbox").focus();
  const octal = [...new TextEncoder().encode("안")].map((byte) => `\\${byte.toString(8)}`).join("");
  await page.keyboard.type(`printf '${octal}\\n'`);
  await page.keyboard.press("Enter");
  const wide = terminal.locator(".term-row:not(.term-scrollback-row) .term-wide").filter({ hasText: "안" }).first();
  await expect(wide).toBeVisible({ timeout: 15_000 });

  const box = await wide.boundingBox();
  if (box === null) throw new Error("the syllable's cell has no box");
  const clip = {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
  const glyph = await cropInk(page, clip);
  const blank = await cropInk(page, { ...clip, x: clip.x + clip.width * 2 });
  return { glyph, blank };
}

test("Hangul typed into a terminal paints its cell, two cells wide (#959)", async ({ page }) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const { glyph, blank } = await syllableInk(page, terminal);
  expect(glyph.width).toBe(blank.width);
  expect(glyph.height).toBe(blank.height);
  expect(glyph.ink).toBeGreaterThan(0);
  expect(blank.ink).toBe(0);

  const ratio = await page.evaluate(() => {
    const terminalElement = document.querySelector("[data-terminal]");
    if (terminalElement === null) throw new Error("the terminal is not on the page");
    const style = getComputedStyle(terminalElement);
    const cell = Number.parseFloat(style.getPropertyValue("--term-cell-width"));
    if (!(cell > 0)) throw new Error("the terminal does not publish its cell width");
    return cell;
  });
  const wideBox = await terminal
    .locator(".term-row:not(.term-scrollback-row) .term-wide")
    .filter({ hasText: "안" })
    .first()
    .boundingBox();
  if (wideBox === null) throw new Error("the syllable's cell has no box");
  expect(wideBox.width / ratio).toBeGreaterThan(1.5);
});

test.describe("the reporter's Android PWA", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    viewport: { width: 800, height: 1280 },
  });

  test("an Android tablet keeps a Hangul face and draws the syllable (#959)", async ({ page }) => {
    await page.goto("/");

    const stack = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-term"));
    expect(HANGUL_FAMILIES.filter((family) => stack.includes(family))).not.toHaveLength(0);

    const terminal = await openNewTerminal(page);
    const { glyph, blank } = await syllableInk(page, terminal);
    expect(glyph.ink).toBeGreaterThan(0);
    expect(blank.ink).toBe(0);
  });
});
