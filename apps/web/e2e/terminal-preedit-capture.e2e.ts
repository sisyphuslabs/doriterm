import { devices, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, openNewTerminal, test } from "./fixtures.ts";

// Captures for #674: a syllable composing after committed Hangul, at both widths in both themes. Run with CAPTURE=1 and
// F674_DIR=<dir>; F674_STATE=before|after names the tree the shots came from. Nothing here needs the preedit to be drawn
// as cells, so the same spec shoots the tree before the change.
test.skip(process.env["CAPTURE"] !== "1", "captures run only with CAPTURE=1");
test.use({ serviceWorkers: "block" });

const DIR = process.env["F674_DIR"] ?? ".";
const STATE = process.env["F674_STATE"] ?? "after";

/** "한글" printed with no newline, then "각" composing at the prompt that follows it. */
async function compose(page: Page, terminal: Locator): Promise<void> {
  const octal = [...new TextEncoder().encode("\u{D55C}\u{AE00}")].map((byte) => `\\${byte.toString(8)}`).join("");
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type(`printf '${octal}'`);
  await page.keyboard.press("Enter");
  await expect(terminal.locator(".term-row .term-wide").filter({ hasText: "\u{AE00}" })).not.toHaveCount(0);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "\u{AC01}", selectionStart: 1, selectionEnd: 1 });
  await expect(terminal.getByRole("textbox")).toHaveValue("\u{AC01}");
}

/** A few rows around the cursor from the grid's left edge: on a wide window the preedit is only a few cells. */
async function capture(page: Page, terminal: Locator, name: string): Promise<void> {
  const clip = await terminal.evaluate((element) => {
    const cursor = element.querySelector(".term-cursor")?.getBoundingClientRect();
    const row = element.querySelector(".term-row:not(.term-scrollback-row)")?.getBoundingClientRect();
    const host = element.getBoundingClientRect();
    if (cursor === undefined || row === undefined) throw new Error("no cursor drawn");
    const y = Math.max(host.top, cursor.top - 2 * row.height);
    return { x: host.left, y, width: Math.min(host.width, 520), height: cursor.bottom + row.height - y };
  });
  mkdirSync(DIR, { recursive: true });
  await page.screenshot({ path: join(DIR, `${STATE}-${name}.png`), clip });
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`desktop ${scheme}`, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

    test(`capture 1440 ${scheme}`, async ({ page }) => {
      await page.goto("/");
      const terminal = await openNewTerminal(page);
      await compose(page, terminal);
      await capture(page, terminal, `1440-${scheme}`);
    });
  });

  test.describe(`phone ${scheme}`, () => {
    const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
    test.use({ ...phone, colorScheme: scheme });

    test(`capture 390 ${scheme}`, async ({ page }) => {
      // The terminal is opened at a desktop width, where the status bar counts it, and the window is narrowed after.
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/");
      const address = await (await openNewTerminal(page)).getAttribute("data-terminal");
      if (address === null) throw new Error("no terminal address");
      await page.setViewportSize({ width: 390, height: 844 });
      const terminal = page.locator(`[data-terminal="${address}"]`);
      const agents = page.locator("button:has([data-floor='name']):has(time)");
      await expect(terminal.or(agents).first()).toBeVisible({ timeout: 20_000 });
      // A narrow window may list the agents instead of showing the terminal; its row opens it again.
      if (!(await terminal.isVisible())) await agents.first().click();
      await expect(terminal).toBeVisible({ timeout: 20_000 });
      await compose(page, terminal);
      await capture(page, terminal, `390-${scheme}`);
    });
  });
}
