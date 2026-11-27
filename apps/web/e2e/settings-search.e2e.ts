import { devices, type Page } from "@playwright/test";
import { pickFile } from "./file-input.ts";
import { expect, test } from "./fixtures.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const settings = (page: Page) => page.getByRole("dialog", { name: "Settings" });
const field = (page: Page) => settings(page).getByRole("searchbox", { name: "Search settings" });

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("one field searches every section: it narrows the list, Enter opens the first match, Escape clears it (#1460)", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Settings" }).click();
    const nav = settings(page).getByRole("navigation", { name: "Settings" });
    await field(page).fill("theme");
    await expect(nav.getByRole("button", { name: "Appearance" })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Keybindings" })).toHaveCount(0);
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

test.describe("desktop: matching settings (#1528)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("a query lists the matching settings; Enter lands on the first, focused, in its section", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Settings" }).click();
    await field(page).fill("cursor");
    const hits = settings(page).getByRole("region", { name: "Matching settings" });
    const style = hits.getByRole("button", { name: /^cursor-style Terminal/ });
    await expect(style).toBeVisible();
    await field(page).press("ArrowDown");
    await expect(hits.getByRole("button").first()).toBeFocused();
    await style.focus();
    await page.keyboard.press("Enter");
    await expect(hits).toHaveCount(0);
    const nav = settings(page).getByRole("navigation", { name: "Settings" });
    await expect(nav.getByRole("button", { name: "Terminal" })).toHaveAttribute("aria-current", "page");
    const landed = settings(page).locator("[data-setting-landed]");
    await expect(landed).toHaveCount(1);
    await expect(landed.locator("#terminal-cursor-style")).toHaveCount(1);
    await expect.poll(() => landed.evaluate((row) => row.contains(document.activeElement))).toBe(true);
  });

  test("landing on a changed key focuses its control, never its Reset, and Space keeps the value (#2920 review)", async ({
    page,
  }) => {
    await page.goto("/settings#terminal");
    const style = settings(page).getByRole("group", { name: "cursor-style" });
    await style.getByRole("button", { name: "bar", exact: true }).click();
    await expect(style.getByRole("button", { name: "bar", exact: true })).toHaveAttribute("aria-pressed", "true");
    const reset = settings(page).getByRole("button", { name: "Reset cursor-style" });
    await expect(reset).toBeVisible();
    await field(page).fill("cursor");
    const hits = settings(page).getByRole("region", { name: "Matching settings" });
    await hits.getByRole("button", { name: /^cursor-style Terminal/ }).click();
    const landed = settings(page).locator("[data-setting-landed]");
    await expect(landed).toHaveCount(1);
    await expect
      .poll(() =>
        landed.evaluate(
          (row) => row.querySelector("[data-setting-control]")?.contains(document.activeElement) ?? false,
        ),
      )
      .toBe(true);
    await expect(reset).not.toBeFocused();
    await page.keyboard.press("Space");
    await expect(style.getByRole("button", { name: "bar", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(reset).toBeVisible();
  });

  test("landing on a set key this build does not apply focuses the row, never its Reset (#2920 review)", async ({
    page,
  }) => {
    await page.goto("/settings#terminal");
    await pickFile(page, "Import Ghostty config…", "config", "minimum-contrast = 3\n");
    const preview = page.getByRole("dialog", { name: "Import this Ghostty config?" });
    await preview.getByRole("button", { name: "Import", exact: true }).click();
    await expect(preview).toHaveCount(0);
    const reset = settings(page).getByRole("button", { name: "Reset minimum-contrast" });
    await expect(reset).toBeVisible();
    await field(page).fill("minimum-contrast");
    const hits = settings(page).getByRole("region", { name: "Matching settings" });
    await hits.getByRole("button", { name: /^minimum-contrast Terminal/ }).click();
    const landed = settings(page).locator("[data-setting-landed]");
    await expect(landed).toHaveCount(1);
    await expect.poll(() => landed.evaluate((row) => document.activeElement === row)).toBe(true);
    await expect(reset).not.toBeFocused();
    await page.keyboard.press("Space");
    // The imported value survives: Reset still shows, so the key is still set.
    await expect(reset).toBeVisible();
  });

  test("keybinds finds the keybinding import, and picking it focuses that button (#1472)", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Settings" }).click();
    await field(page).fill("keybinds");
    const hits = settings(page).getByRole("region", { name: "Matching settings" });
    await hits.getByRole("button", { name: /^Import keybinds…/ }).click();
    await expect(settings(page).getByRole("button", { name: "Import keybinds…" })).toBeFocused();
  });
});

test.describe("desktop: a match that lands nowhere (#1545 review)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the next search keeps the field: a pending landing never takes the focus from it", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Settings" }).click();
    await field(page).fill("connect through");
    const hits = settings(page).getByRole("region", { name: "Matching settings" });
    await hits.getByRole("button", { name: /^Connect through/ }).click();
    await field(page).click();
    await field(page).pressSequentially("connect");
    await expect(field(page)).toHaveValue("connect");
    await expect(field(page)).toBeFocused();
    await expect(hits.locator("[data-setting-landed]")).toHaveCount(0);
  });
});

test.describe("phone", () => {
  const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
  test.use(phone);

  test("the phone's list of sections narrows to the sections that hold the words (#1460)", async ({ page }) => {
    await page.goto("/settings");
    await field(page).fill("relay");
    const list = settings(page).locator("[data-settings-list]");
    await expect(list.getByRole("button", { name: "This device" })).toBeVisible();
    await expect(list.getByRole("button")).toHaveCount(1);
  });

  test("a tapped match opens its section with that row in view (#1528)", async ({ page }) => {
    await page.goto("/settings");
    await field(page).fill("awake");
    const hits = settings(page).getByRole("region", { name: "Matching settings" });
    await hits.getByRole("button", { name: /^Keep the screen awake/ }).tap();
    const landed = settings(page).locator("[data-setting-landed]");
    await expect(landed).toContainText("Keep the screen awake");
    await expect(landed).toBeInViewport();
  });
});
