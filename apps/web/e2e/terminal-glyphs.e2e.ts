import type { Locator, Page } from "@playwright/test";
import { expect, followSystemAppearance, openNewTerminal, test } from "./fixtures.ts";
import { loadKoreanFonts } from "./korean-fonts.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

/** Prints `text` in the terminal, typed as UTF-8 octal so the keyboard input stays ASCII. */
async function print(page: Page, terminal: Locator, text: string): Promise<void> {
  const octal = [...new TextEncoder().encode(text)].map((byte) => `\\${byte.toString(8)}`).join("");
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type(`printf '${octal}\\n'`);
  await page.keyboard.press("Enter");
}

const liveWide = (terminal: Locator) => terminal.locator(".term-row:not(.term-scrollback-row) .term-wide");

async function expectCentred(page: Page, terminal: Locator): Promise<void> {
  await print(page, terminal, "w\u{AC00}w");
  const wide = liveWide(terminal).filter({ hasText: "\u{AC00}" });
  await expect(wide).toHaveCount(1, { timeout: 15_000 });
  const margins = await wide.evaluate((span) => {
    const box = span.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(span);
    const glyph = range.getBoundingClientRect();
    return { left: glyph.left - box.left, right: box.right - glyph.right };
  });
  expect(Math.abs(margins.left - margins.right)).toBeLessThan(1);
}

async function openTerminalSettings(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Settings" }).first().click();
  await page
    .getByRole("tab", { name: "Terminal" })
    .or(page.getByRole("button", { name: "Terminal" }))
    .first()
    .click();
}

/** Closes Settings and returns the focused terminal once its prompt is back. */
async function closeSettings(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Close settings" }).first().click();
  const focused = page.locator('[data-focused="true"] [data-terminal]');
  await expect(focused).toContainText("$", { timeout: 20_000 });
  return focused;
}

test("a wide glyph is centred in its two cells", async ({ page }) => {
  await page.goto("/");
  await expectCentred(page, await openNewTerminal(page));
});

test("adjust-cell-width widens the cells, not the wide glyph inside them: it stays centred", async ({ page }) => {
  await page.goto("/");
  await openNewTerminal(page);
  await openTerminalSettings(page);
  await page.getByRole("textbox", { name: "adjust-cell-width" }).fill("4");
  await page.keyboard.press("Enter");
  const focused = await closeSettings(page);
  await expect
    .poll(() =>
      focused
        .locator(".term-row")
        .first()
        .evaluate((row) => getComputedStyle(row).letterSpacing),
    )
    .toBe(
      await focused.evaluate(
        (element) => `${4 + parseFloat(getComputedStyle(element).getPropertyValue("--term-native-spacing"))}px`,
      ),
    );
  await expectCentred(page, focused);
});

// CJK fonts with their own Hangul, one for each place the suite runs: the Linux build hosts carry Noto Sans Mono CJK,
// and CI's Playwright dependencies carry WenQuanYi Zen Hei. Whichever is installed is the user's chosen font.
async function addFontFamily(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Add font-family", exact: true }).click();
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
}

test("a user-chosen font that has Hangul draws it at its own size: only a fallback face is resized", async ({
  page,
}) => {
  await page.goto("/");
  await loadKoreanFonts(page);
  await openNewTerminal(page);
  await openTerminalSettings(page);
  await addFontFamily(page, "Terminal Korean Fixture");
  await addFontFamily(page, "Terminal Latin Fixture");
  const terminal = await closeSettings(page);
  await expect
    .poll(() => terminal.evaluate((element) => getComputedStyle(element).fontFamily))
    .toContain("Terminal Korean Fixture");
  await print(page, terminal, "\u{D55C}\u{AE00}");
  const syllables = liveWide(terminal).filter({ hasText: /^[\u{AC00}-\u{D7A3}]$/u });
  await expect(syllables).toHaveCount(2, { timeout: 15_000 });
  const sizes = await terminal.evaluate((element) => {
    const style = getComputedStyle(element);
    const context = document.createElement("canvas").getContext("2d");
    if (context === null) throw new Error("no canvas");
    const ink = (family: string) => {
      context.font = `${style.fontSize} ${family}`;
      const glyph = context.measureText("\u{D55C}");
      return [glyph.width, glyph.actualBoundingBoxLeft, glyph.actualBoundingBoxRight, glyph.actualBoundingBoxAscent];
    };
    const spans = [...element.querySelectorAll(".term-row:not(.term-scrollback-row) .term-wide")];
    return {
      terminal: style.fontSize,
      spans: spans.map((span) => getComputedStyle(span).fontSize),
      // The user's font drew the syllable when it differs from what the default stack falls back to.
      ownFont: ink(style.fontFamily).join() !== ink(style.getPropertyValue("--font-term")).join(),
    };
  });
  expect(sizes.ownFont).toBe(true);
  for (const size of sizes.spans) expect(size).toBe(sizes.terminal);
});

test("Hangul fills its two cells as Ghostty sizes a fallback font, leaving no wider gap than the ASCII baseline sets", async ({
  page,
}) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await print(page, terminal, "\u{BE0C}\u{B77C}\u{C6B0}\u{C800} abcd");
  const syllables = liveWide(terminal).filter({ hasText: /^[\u{AC00}-\u{D7A3}]$/u });
  await expect(syllables).toHaveCount(4, { timeout: 15_000 });
  // The ASCII baseline in the terminal's own font: one cell, and the height of the ink of every printable ASCII glyph.
  const ascii = await terminal.evaluate((element) => {
    const context = document.createElement("canvas").getContext("2d");
    if (context === null) throw new Error("no canvas");
    const style = getComputedStyle(element);
    context.font = `${style.fontSize} ${style.fontFamily}`;
    let ascent = 0;
    let descent = 0;
    for (let code = 0x21; code < 0x7f; code++) {
      const ink = context.measureText(String.fromCharCode(code));
      ascent = Math.max(ascent, ink.actualBoundingBoxAscent);
      descent = Math.max(descent, ink.actualBoundingBoxDescent);
    }
    return { cell: parseFloat(style.getPropertyValue("--term-cell-width")), height: ascent + descent };
  });
  const cells = 2 * ascii.cell;
  // Ghostty's advance for a fallback ideograph next to a font without one: min(ASCII height, two cells).
  const gapAllowed = cells - Math.min(ascii.height, cells);
  const measured = await syllables.evaluateAll((spans) =>
    spans.map((span) => {
      const range = document.createRange();
      range.selectNodeContents(span);
      return { box: span.getBoundingClientRect().width, advance: range.getBoundingClientRect().width };
    }),
  );
  for (const { box, advance } of measured) {
    expect(Math.abs(box - cells)).toBeLessThan(0.5);
    expect(advance).toBeLessThanOrEqual(box + 0.01);
    // Chromium on Linux rounds advances to whole pixels, so the glyph may come one pixel short of Ghostty's.
    expect(box - advance - gapAllowed).toBeLessThanOrEqual(1);
  }
});

test("a block split across two fallback faces keeps every wide glyph's ink inside its two cells (#252)", async ({
  page,
}) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  // \u6C34 and \u4E2D come from the first face that has them (a Korean Hanja font, where one is installed); the
  // simplified-only \u6D4B\u8BD5\u7B80\u4F53 fall back to a Chinese face. Hangul and kana are their own blocks.
  await print(page, terminal, "\u{6D4B}\u{8BD5}\u{7B80}\u{4F53} \u{6C34}\u{4E2D} \u{D55C}\u{AE00} \u{3042}\u{3044}");
  const wide = liveWide(terminal);
  await expect(wide).toHaveCount(10, { timeout: 15_000 });
  const glyphs = await wide.evaluateAll((spans) => {
    const context = document.createElement("canvas").getContext("2d");
    return spans.map((span) => {
      const box = span.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(span);
      const advance = range.getBoundingClientRect();
      const style = getComputedStyle(span);
      let inkLeft = advance.left;
      let inkRight = advance.right;
      if (context !== null) {
        context.font = `${style.fontSize} ${style.fontFamily}`;
        const ink = context.measureText(span.textContent ?? "");
        inkLeft = advance.left - ink.actualBoundingBoxLeft;
        inkRight = advance.left + ink.actualBoundingBoxRight;
      }
      return {
        text: span.textContent ?? "",
        box: { left: box.left, right: box.right },
        advance: { left: advance.left, right: advance.right },
        ink: { left: inkLeft, right: inkRight },
      };
    });
  });
  for (const glyph of glyphs) {
    // Half a pixel either way for subpixel positioning; a glyph sized past its cells is a whole pixel over.
    expect
      .soft(glyph.advance.left, `${glyph.text}: advance starts inside`)
      .toBeGreaterThanOrEqual(glyph.box.left - 0.5);
    expect.soft(glyph.advance.right, `${glyph.text}: advance ends inside`).toBeLessThanOrEqual(glyph.box.right + 0.5);
    expect.soft(glyph.ink.left, `${glyph.text}: ink starts inside`).toBeGreaterThanOrEqual(glyph.box.left - 0.5);
    expect.soft(glyph.ink.right, `${glyph.text}: ink ends inside`).toBeLessThanOrEqual(glyph.box.right + 0.5);
  }
  // Hangul and kana still fill their two cells: their size does not change.
  for (const glyph of glyphs.filter(({ text }) => /[\u{AC00}-\u{D7A3}\u{3040}-\u{30FF}]/u.test(text))) {
    const box = glyph.box.right - glyph.box.left;
    expect.soft(glyph.advance.right - glyph.advance.left, `${glyph.text}: fills its cells`).toBeGreaterThan(box - 1);
  }
});

/** WCAG relative luminance of a computed `rgb(...)` colour. */
function luminance(css: string): number {
  const channels = (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  const [r = 0, g = 0, b = 0] = channels.map((value) => {
    const c = value / 255;
    return c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(colorScheme, () => {
    test.use({ colorScheme });

    test("IME preedit text is dark on a light field, legible on the browser's composition highlight", async ({
      page,
    }) => {
      await followSystemAppearance(page);
      await page.goto("/");
      const terminal = await openNewTerminal(page);
      await terminal.getByRole("textbox").focus();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.imeSetComposition", { text: "\u{D55C}", selectionStart: 1, selectionEnd: 1 });
      await expect(terminal.getByRole("textbox")).toHaveValue("\u{D55C}");
      // The preedit is painted as cells at the cursor (#674), not by the input that holds it.
      const preedit = terminal.locator(".term-preedit");
      await expect(preedit).toHaveText("\u{D55C}");
      const colors = await preedit.evaluate((field) => {
        const style = getComputedStyle(field);
        return { text: style.color, field: style.backgroundColor };
      });
      const text = luminance(colors.text);
      const field = luminance(colors.field);
      expect(text).toBeLessThan(field);
      expect((field + 0.05) / (text + 0.05)).toBeGreaterThanOrEqual(4.5);
    });
  });
}
