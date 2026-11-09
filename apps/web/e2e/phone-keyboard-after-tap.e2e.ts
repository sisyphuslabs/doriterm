import { devices, type Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { iosInputSession } from "./ios-input-session.ts";
import { key, keysBar } from "./phone-key-bar.ts";

const { defaultBrowserType: _iphoneBrowser, ...IPHONE } = devices["iPhone 14"];
const { defaultBrowserType: _pixelBrowser, ...PIXEL } = devices["Pixel 7"];
const phone = (browserName: string) => (browserName === "webkit" ? IPHONE : PIXEL);

// A finger on a phone whose soft keyboard follows iOS's input session (ios-input-session.ts): the keyboard button must
// raise the keyboard however the terminal's field was focused before it (#1941).
test.use({
  serviceWorkers: "block",
  viewport: { width: 390, height: 844 },
  userAgent: async ({ browserName }, use) => use(phone(browserName).userAgent),
  deviceScaleFactor: async ({ browserName }, use) => use(phone(browserName).deviceScaleFactor),
  isMobile: async ({ browserName }, use) => use(phone(browserName).isMobile),
  hasTouch: async ({ browserName }, use) => use(phone(browserName).hasTouch),
});

async function openTerminal(page: Page) {
  await iosInputSession(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("banner").getByRole("button", { name: "New tab" }).click();
  const terminal = page.locator("[data-terminal]");
  await expect(terminal).toContainText("$", { timeout: 15_000 });
  return { terminal, input: terminal.locator("textarea") };
}

async function expectUp(page: Page): Promise<void> {
  await expect(keysBar(page)).toBeVisible();
  await expect(key(page, "Show keyboard")).toHaveCount(0);
}

async function expectDown(page: Page): Promise<void> {
  await expect(key(page, "Show keyboard")).toBeVisible();
  await expect(keysBar(page)).toHaveCount(0);
}

test("a tap on the terminal first, then the keyboard button: the keyboard rises (#1941)", async ({ page }) => {
  const { terminal, input } = await openTerminal(page);
  await terminal.tap();
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("inputmode", "none");
  await expectDown(page);

  await key(page, "Show keyboard").tap();
  await expect(input).toBeFocused();
  await expectUp(page);
});

test("the keyboard button raises it with nothing focused, and again after the keyboard's own key put it down (#1941)", async ({
  page,
}) => {
  const { input } = await openTerminal(page);
  await key(page, "Show keyboard").tap();
  await expectUp(page);

  await page.evaluate(() => (Reflect.get(window, "softKeyboard") as (px: number) => void)(0));
  await expectDown(page);
  await expect(input).not.toBeFocused();

  await key(page, "Show keyboard").tap();
  await expect(input).toBeFocused();
  await expectUp(page);
});
