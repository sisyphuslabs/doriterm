// #1404: an app added to the Home Screen starts in a storage container of its own, so it has no pairing and a device key
// the host has never seen. It joins the way any empty partition does - dev's JoinEntry offers an invite in place - and
// the one thing this app needs told is WHY it is unpaired, which it says beside the paste box. An installed app whose
// storage does hold the pairing (Chromium shares the profile's) and a browser tab are unchanged.
import { devices, type Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const JOIN = { name: "Join a mesh", exact: true };
const WHY = /its own storage|separate storage/;

/** The page runs as an installed app: `display-mode: standalone` matches, as device-install.e2e.ts emulates it. */
const runInstalled = (page: Page) =>
  page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query: string) =>
      query === "(display-mode: standalone)" ? { ...original(query), matches: true } : original(query);
  });

/** Nothing in storage: the fixture seeds this computer's settings first, and this runs after it, before the app reads. */
const emptyStorage = (page: Page) => page.addInitScript(() => localStorage.removeItem("doriface.connection"));

test.describe("an iPhone Home Screen app with nothing in its storage", () => {
  const { defaultBrowserType: _brand, ...iphone } = devices["iPhone 14"];
  test.use({ ...iphone });

  test("is told why it is unpaired, and pairs in place from the paste box", async ({ page }) => {
    await runInstalled(page);
    await emptyStorage(page);
    await page.goto("/");

    await expect(page.getByRole("heading", JOIN)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Paste invite", exact: true })).toBeVisible();
    await expect(page.getByText(WHY)).toBeVisible();
  });

  test("an app whose storage holds the pairing opens the workspace, with no first run", async ({ page }) => {
    await runInstalled(page);
    await page.goto("/");

    // The workspace is there first, so the absences below are of a first run, not of a page that drew nothing (#2356).
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", JOIN)).toHaveCount(0);
    await expect(page.getByText(WHY)).toHaveCount(0);
  });
});

test.describe("a browser tab", () => {
  test("with nothing in its storage keeps the host first run, with no installed-app explanation", async ({ page }) => {
    await emptyStorage(page);
    await page.goto("/");

    await expect(page.getByRole("heading", JOIN)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(WHY)).toHaveCount(0);
  });
});
