import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { pressShortcut } from "./platform-keys.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const openKeybindings = async (page: Page) => {
  await page.goto("/settings");
  await page
    .getByRole("tab", { name: "Keybindings" })
    .or(page.getByRole("button", { name: "Keybindings" }))
    .first()
    .click();
};
const row = (page: Page, id: string) => page.locator(`[id="keybinding-${id}"]`).locator("xpath=../..");
const recordButton = (page: Page, label: string) =>
  page.getByRole("button", { name: `Record a shortcut for ${label}`, exact: true });
const recorder = (page: Page) => page.getByRole("status").filter({ hasText: "Press keys…" });
const focusOnBody = (page: Page) => page.evaluate(() => document.activeElement === document.body);

test("the recorder holds focus while it listens and hands it back to its row", async ({ page }) => {
  await openKeybindings(page);
  const record = recordButton(page, "New tab");
  await record.click();
  await expect(recorder(page)).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(recorder(page)).toHaveCount(0);
  await expect(record).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(recorder(page)).toBeFocused();
  await page.keyboard.press("Control+Alt+N");
  await expect(row(page, "tab.new").getByText("Changed")).toBeVisible();
  await expect(record).toBeFocused();
});

test("Tab and Shift+Tab leave the recorder without binding; a modified Tab is still recorded", async ({ page }) => {
  await openKeybindings(page);
  const close = row(page, "tab.close");
  const record = recordButton(page, "Close tab");

  await record.click();
  await page.keyboard.press("Tab");
  await expect(recorder(page)).toHaveCount(0);
  expect(await focusOnBody(page)).toBe(false);
  await expect(close.getByText("Changed")).toHaveCount(0);

  await record.click();
  await page.keyboard.press("Shift+Tab");
  await expect(recorder(page)).toHaveCount(0);
  await expect(close.getByRole("button", { name: /^Remove .* from Close tab$/ }).last()).toBeFocused();
  await expect(close.getByText("Changed")).toHaveCount(0);

  await record.click();
  await page.keyboard.press("Alt+Tab");
  await expect(close.getByText("Changed")).toBeVisible();
  await expect(record).toBeFocused();
});

test("the conflict prompt takes focus on Keep, and Escape keeps the old binding", async ({ page }) => {
  await openKeybindings(page);
  const close = row(page, "tab.close");
  const record = recordButton(page, "Close tab");

  await record.click();
  await pressShortcut(page, "tab.new");
  const keep = close.getByRole("button", { name: "Keep", exact: true });
  await expect(keep).toBeFocused();
  expect(await keep.evaluate((button) => button.matches(":focus-visible"))).toBe(true);

  await page.keyboard.press("Escape");
  await expect(keep).toHaveCount(0);
  await expect(close.getByText("Changed")).toHaveCount(0);
  await expect(row(page, "tab.new").getByText("Changed")).toHaveCount(0);
  await expect(page).toHaveURL(/\/settings$/);
  await expect(record).toBeFocused();
});
