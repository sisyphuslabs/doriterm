import { devices, type Locator, type Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { openSettingsSection } from "./settings-sections.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const settings = (page: Page): Locator => page.getByRole("dialog", { name: "Settings" });
const searchField = (page: Page): Locator => settings(page).getByRole("searchbox", { name: "Search settings" });
const wordmarkSwitch = (page: Page): Locator => settings(page).getByRole("switch", { name: "Show app name" });
const titlebarOf = (sidebar: Locator): Locator => sidebar.locator("[data-titlebar]");

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("searching Show app name hides and restores the sidebar wordmark live and across reload (#2967)", async ({
    page,
  }) => {
    await page.goto("/");
    const workspaceSidebar = page.getByRole("complementary", { name: "Workspace" });
    const titlebar = titlebarOf(workspaceSidebar);
    await expect(titlebar.locator('img[src="/icon.svg"]')).toBeVisible({ timeout: 20_000 });
    await expect(titlebar.getByText("Doriterm", { exact: true })).toBeVisible();
    await expect(titlebar.getByRole("button", { name: "Command palette" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
    await expect(page).toHaveTitle("Doriterm");

    await workspaceSidebar.getByRole("link", { name: "Settings" }).click();
    await searchField(page).fill("wordmark");
    const hits = settings(page).getByRole("region", { name: "Matching settings" });
    await hits.getByRole("button", { name: /^Show app name Appearance/ }).click();

    const landed = settings(page).locator("[data-setting-landed]");
    await expect(landed).toContainText("Show app name");
    const toggle = wordmarkSwitch(page);
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    // Hiding updates the workspace behind the dialog immediately while keeping icon, controls and page title intact.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    const behindTitlebar = page.locator('aside[aria-label="Workspace"] [data-titlebar]');
    await expect(behindTitlebar.getByText("Doriterm", { exact: true })).toHaveCount(0);
    await expect(behindTitlebar.locator('img[src="/icon.svg"]')).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(settings(page)).toHaveCount(0);
    await expect(titlebar.locator('img[src="/icon.svg"]')).toBeVisible();
    await expect(titlebar.getByText("Doriterm", { exact: true })).toHaveCount(0);
    await expect(titlebar.getByRole("button", { name: "Command palette" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
    await expect(page).toHaveTitle("Doriterm");

    // Reloading preserves the hidden wordmark and switch state.
    await page.reload();
    await expect(titlebar.locator('img[src="/icon.svg"]')).toBeVisible({ timeout: 20_000 });
    await expect(titlebar.getByText("Doriterm", { exact: true })).toHaveCount(0);
    await expect(titlebar.getByRole("button", { name: "Command palette" })).toBeVisible();
    await expect(page).toHaveTitle("Doriterm");

    // Rail mode still omits the titlebar brand and expanding restores the hidden-wordmark sidebar.
    const separator = page.getByRole("separator", { name: "Resize sidebar" });
    await separator.focus();
    await page.keyboard.press("Enter");
    await expect(workspaceSidebar).toHaveAttribute("data-rail", "true");
    await expect(titlebar.locator('img[src="/icon.svg"]')).toHaveCount(0);
    await expect(titlebar.getByText("Doriterm", { exact: true })).toHaveCount(0);
    await workspaceSidebar.getByRole("button", { name: "Expand sidebar" }).click();
    await expect(workspaceSidebar).not.toHaveAttribute("data-rail", "true");
    await expect(titlebar.locator('img[src="/icon.svg"]')).toBeVisible();
    await expect(titlebar.getByText("Doriterm", { exact: true })).toHaveCount(0);

    // Turning it back on restores the wordmark immediately and survives a reload.
    await workspaceSidebar.getByRole("link", { name: "Settings" }).click();
    await openSettingsSection(page, "Appearance");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(behindTitlebar.getByText("Doriterm", { exact: true })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(titlebar.getByText("Doriterm", { exact: true })).toBeVisible();
    await page.reload();
    await expect(titlebar.locator('img[src="/icon.svg"]')).toBeVisible({ timeout: 20_000 });
    await expect(titlebar.getByText("Doriterm", { exact: true })).toBeVisible();
  });
});

test.describe("iPad drawer", () => {
  test.use({ viewport: { width: 820, height: 1180 } });

  test("the medium-tier drawer follows Show app name while the rail stays unchanged (#2967)", async ({ page }) => {
    await page.goto("/");
    const rail = page.locator('aside[aria-label="Workspace"][data-rail="true"]');
    await expect(rail).toBeVisible({ timeout: 20_000 });
    await expect(titlebarOf(rail).locator('img[src="/icon.svg"]')).toHaveCount(0);
    await expect(titlebarOf(rail).getByText("Doriterm", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Show sidebar" }).click();
    const drawer = page.locator("[data-sidebar-drawer]");
    const drawerTitlebar = titlebarOf(drawer);
    await expect(drawerTitlebar.locator('img[src="/icon.svg"]')).toBeVisible();
    await expect(drawerTitlebar.getByText("Doriterm", { exact: true })).toBeVisible();
    await expect(drawerTitlebar.getByRole("button", { name: "Command palette" })).toBeVisible();

    await drawer.getByRole("link", { name: "Settings" }).click();
    await searchField(page).fill("logo");
    const hits = settings(page).getByRole("region", { name: "Matching settings" });
    await hits.getByRole("button", { name: /^Show app name Appearance/ }).click();
    const toggle = wordmarkSwitch(page);
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await settings(page).getByRole("button", { name: "Close settings" }).click();
    await expect(settings(page)).toHaveCount(0);
    await expect(drawerTitlebar.locator('img[src="/icon.svg"]')).toBeVisible();
    await expect(drawerTitlebar.getByText("Doriterm", { exact: true })).toHaveCount(0);
    await expect(drawerTitlebar.getByRole("button", { name: "Command palette" })).toBeVisible();

    await page.reload();
    await expect(rail).toBeVisible({ timeout: 20_000 });
    await expect(titlebarOf(rail).locator('img[src="/icon.svg"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Show sidebar" }).click();
    await expect(drawerTitlebar.locator('img[src="/icon.svg"]')).toBeVisible();
    await expect(drawerTitlebar.getByText("Doriterm", { exact: true })).toHaveCount(0);
  });
});

test.describe("phone", () => {
  const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
  test.use(phone);

  test("searching Doriterm opens Show app name and persists across reload (#2967)", async ({ page }) => {
    await page.goto("/settings");
    await searchField(page).fill("Doriterm");
    const hits = settings(page).getByRole("region", { name: "Matching settings" });
    await hits.getByRole("button", { name: /^Show app name Appearance/ }).tap();
    const landed = settings(page).locator("[data-setting-landed]");
    await expect(landed).toContainText("Show app name");
    const toggle = wordmarkSwitch(page);
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await page.reload();
    await openSettingsSection(page, "Appearance");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  });
});
