// #1404: an app added to the Home Screen starts in a storage container of its own, so it has no pairing and a device key
// the host has never seen. It is told to pair once, from the Safari tab's own terminals when it has one, and the code it
// types there reaches a shell. An installed app whose storage does hold the pairing (Chromium shares the profile's) and a
// browser tab are unchanged.
import { devices, type Page } from "@playwright/test";
import { expect, terminalCount, test } from "./fixtures.ts";
import { startFakeRelayHost } from "./relay-route.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const INSTALLED = { name: "Pair this app once" };
const BROWSER = { name: "Connect to a host" };
const PAIRED = "This device now reaches the host through the relay";

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
  const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
  test.use(phone);

  test("is told to pair once, from the Safari tab's terminals, and the typed code reaches a shell", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const host = await startFakeRelayHost();
    try {
      await runInstalled(page);
      await emptyStorage(page);
      await host.route(page);
      await page.goto("/");
      await expect(page.getByRole("heading", INSTALLED)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(/Already paired in Safari on this phone/)).toBeVisible();
      await expect(page.getByRole("heading", BROWSER)).toHaveCount(0);

      const { code } = await host.pairingOffer();
      await page.getByRole("link", { name: "Type the pairing code" }).click();
      await page.getByLabel("Pairing code").fill(code);
      await page.getByRole("button", { name: "Pair", exact: true }).click();
      await expect(page.getByRole("figure").filter({ hasText: "Host key (SHA-256)" })).toBeVisible({
        timeout: 60_000,
      });
      await page.getByRole("button", { name: "They match" }).click();
      await expect(page.getByText(PAIRED)).toBeVisible({ timeout: 90_000 });
      await page.getByRole("link", { name: "Open terminals" }).click();

      // Usable: the workspace is up, and a terminal started from it answers with a prompt over the relay.
      const guide = page.getByRole("region", { name: "Getting started" });
      await expect(guide).toBeVisible({ timeout: 60_000 });
      await guide.getByRole("button", { name: "Start a terminal" }).click();
      await expect(page.locator("[data-terminal]")).toContainText("$", { timeout: 30_000 });
    } finally {
      await host.stop();
    }
  });
});

test("an installed app whose storage holds the pairing opens the workspace, with no first run", async ({ page }) => {
  await runInstalled(page);
  await page.goto("/");
  await terminalCount(page);
  await expect(page.getByRole("heading", INSTALLED)).toHaveCount(0);
  await expect(page.getByRole("heading", BROWSER)).toHaveCount(0);
});

test("a browser tab with its settings opens the workspace as before", async ({ page }) => {
  await page.goto("/");
  await terminalCount(page);
  await expect(page.getByRole("heading", INSTALLED)).toHaveCount(0);
});

test("a browser tab with nothing in its storage keeps the host first run", async ({ page }) => {
  await emptyStorage(page);
  await page.goto("/");
  await expect(page.getByRole("heading", BROWSER)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", INSTALLED)).toHaveCount(0);
});
