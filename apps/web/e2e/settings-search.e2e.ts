import { devices, type Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const settings = (page: Page) => page.getByRole("dialog", { name: "Settings" });
const field = (page: Page) => settings(page).getByRole("searchbox", { name: "Search settings" });

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("one field searches every section: it narrows the list, Enter opens the first, Escape clears it (#1460)", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Settings" }).click();
    const nav = settings(page).getByRole("navigation", { name: "Settings" });
    await field(page).fill("theme");
    await expect(nav.getByRole("button", { name: "Appearance" })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Terminal" })).toHaveCount(0);
    await field(page).press("Enter");
    await expect(nav.getByRole("button", { name: "Appearance" })).toHaveAttribute("aria-current", "page");
    await expect(settings(page).getByRole("heading", { name: "Appearance", level: 2 })).toBeVisible();

    await field(page).fill("zzz");
    await expect(nav).toContainText('No setting matches "zzz"');
    await field(page).press("Escape");
    await expect(field(page)).toHaveValue("");
    await expect(settings(page)).toBeVisible();
    await expect(nav.getByRole("button", { name: "Keybindings" })).toBeVisible();
  });
});

test.describe("phone", () => {
  const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
  test.use(phone);

  test("the phone's section tabs narrow to the sections that hold the words (#1460)", async ({ page }) => {
    await page.goto("/settings");
    await field(page).fill("relay");
    const tabs = settings(page).getByRole("tablist");
    await expect(tabs.getByRole("tab", { name: "This device" })).toBeVisible();
    await expect(tabs.getByRole("tab")).toHaveCount(1);
  });
});
