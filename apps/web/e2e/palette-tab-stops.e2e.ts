import type { Page } from "@playwright/test";
import { expect, terminalCount, test } from "./fixtures.ts";
import { pressShortcut } from "./platform-keys.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const dialog = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const combobox = (page: Page) => page.getByRole("combobox", { name: "Command" });

test("the palette's Tab cycle skips controls taken out of the tab order", async ({ page }) => {
  await page.goto("/");
  await terminalCount(page);
  await pressShortcut(page, "app.palette");
  await expect(combobox(page)).toBeFocused();
  await dialog(page).evaluate((frame) => {
    const skipped = document.createElement("button");
    skipped.tabIndex = -1;
    skipped.textContent = "skipped";
    frame.append(skipped);
  });
  await page.keyboard.press("Tab");
  await expect(combobox(page)).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(combobox(page)).toBeFocused();
});
