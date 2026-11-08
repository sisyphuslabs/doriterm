import { devices, type Locator, type Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { fakeSoftKeyboard, key, keysBar } from "./phone-key-bar.ts";
import { pointOn, pointOnRowStart } from "./terminal-points.ts";
import { Touch } from "./touch.ts";

// On a phone a touch on the terminal never raises the soft keyboard: only the keyboard button does, and the same
// control puts it down (#1375). Each phone runs in its own engine: the iPhone in WebKit (E2E_BROWSERS=all), the Pixel
// in Chromium. The fake keyboard rises on any focus of a text field, so a focus the terminal took by itself shows as a
// shorter visual viewport and the keys bar riding on it.
const PHONES = [
  { name: "iPhone 15", engine: "webkit" },
  { name: "Pixel 7", engine: "chromium" },
] as const;

const field = (page: Page): Locator => page.locator("[data-terminal] textarea");
const viewportHeight = (page: Page): Promise<number> => page.evaluate(() => window.visualViewport?.height ?? 0);
const painted = (page: Page): Locator => page.locator(".term-selection-cells > div");
const scrollTop = (viewport: Locator): Promise<number> => viewport.evaluate((element) => element.scrollTop);

async function openTerminal(page: Page): Promise<Locator> {
  await fakeSoftKeyboard(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("banner").getByRole("button", { name: "New tab" }).tap();
  const terminal = page.locator("[data-terminal]");
  await expect(terminal).toContainText("$", { timeout: 15_000 });
  return terminal;
}

async function expectKeyboardDown(page: Page, height: number): Promise<void> {
  await expect(key(page, "Show keyboard")).toHaveAttribute("aria-pressed", "false");
  await expect(keysBar(page)).toHaveCount(0);
  await expect(field(page)).not.toBeFocused();
  expect(await viewportHeight(page)).toBe(height);
}

async function typeWithKeyboard(page: Page, text: string): Promise<void> {
  await key(page, "Show keyboard").tap();
  await expect(field(page)).toBeFocused();
  await page.keyboard.type(text);
  await key(page, "Hide keyboard").tap();
  await expect(field(page)).not.toBeFocused();
}

for (const phone of PHONES) {
  test.describe(phone.name, () => {
    const { defaultBrowserType: _browser, ...device } = devices[phone.name];
    test.use({ serviceWorkers: "block", ...device, viewport: { width: 390, height: 844 } });
    test.skip(({ browserName }) => browserName !== phone.engine, `${phone.name} runs in ${phone.engine}`);

    test("a tap on the terminal leaves the keyboard down; the keyboard button raises it and puts it down", async ({
      page,
    }, testInfo) => {
      const terminal = await openTerminal(page);
      const height = await viewportHeight(page);
      await expectKeyboardDown(page, height);
      await expect(field(page)).toHaveAttribute("inputmode", "none");

      await terminal.tap();
      await testInfo.attach("after a tap on the terminal", { body: await page.screenshot(), contentType: "image/png" });
      await expectKeyboardDown(page, height);

      await key(page, "Show keyboard").tap();
      await expect(field(page)).toBeFocused();
      await expect(field(page)).toHaveAttribute("inputmode", "text");
      await expect(keysBar(page)).toBeVisible();
      await expect(key(page, "Hide keyboard")).toHaveAttribute("aria-pressed", "true");
      expect(await viewportHeight(page)).toBeLessThan(height);
      await testInfo.attach("after the keyboard button", { body: await page.screenshot(), contentType: "image/png" });

      await key(page, "Hide keyboard").tap();
      await expectKeyboardDown(page, height);
    });

    test("a tap on a link offers its menu without raising the keyboard", async ({ page }) => {
      const terminal = await openTerminal(page);
      const height = await viewportHeight(page);
      await typeWithKeyboard(page, "echo https://example.com/$((6*7))\r");
      await expect(terminal).toContainText("https://example.com/42", { timeout: 15_000 });

      const at = await pointOn(terminal, "example.com/42", "example");
      await page.touchscreen.tap(at.x, at.y);
      const menu = page.getByRole("menu", { name: "Link" });
      await expect(menu).toContainText("https://example.com/42");
      await expect(field(page)).not.toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expectKeyboardDown(page, height);
    });

    test("a held touch still selects and a swipe still scrolls, with the keyboard left down", async ({
      page,
      browserName,
    }) => {
      test.skip(browserName !== "chromium", "a held or moving finger is CDP touch input, which only Chromium has");
      const terminal = await openTerminal(page);
      const height = await viewportHeight(page);
      const viewport = page.locator("[data-slot=terminal-viewport]");
      await typeWithKeyboard(page, "seq 1 200\r");
      await expect(terminal).toContainText("200", { timeout: 15_000 });
      await expect.poll(() => scrollTop(viewport)).toBeGreaterThan(0);

      const touch = await Touch.on(page);
      const row = await pointOnRowStart(terminal, "198");
      await touch.down(row);
      await expect.poll(() => painted(page).count()).toBeGreaterThan(0);
      await touch.up(row);
      const menu = page.getByRole("menu", { name: "Selected text" });
      await expect(menu).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expectKeyboardDown(page, height);

      const before = await scrollTop(viewport);
      const at = await pointOnRowStart(terminal, "200");
      await touch.down(at);
      await touch.drag(at, { x: at.x, y: at.y + 260 });
      await touch.up({ x: at.x, y: at.y + 260 });
      await expect.poll(() => scrollTop(viewport)).toBeLessThan(before);
      await expectKeyboardDown(page, height);
    });
  });
}
