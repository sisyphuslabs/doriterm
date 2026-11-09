// #1378: every page has exactly one <main> landmark, around its primary content, so a screen reader can jump straight
// to it: the panes of the workspace, the list or the open terminal on a phone, and the steps of the first-run page.
import { devices, type Page } from "@playwright/test";
import { endAgent, startAgent } from "./agents.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const main = (page: Page) => page.getByRole("main");

test("the workspace has one main landmark, around its panes and not its chrome", async ({ page }) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = await terminal.getAttribute("data-terminal");
  await expect(main(page)).toHaveCount(1);
  await expect(main(page).locator(`[data-terminal="${address}"]`)).toBeVisible();
  await expect(main(page).getByRole("tabpanel")).toBeVisible();
  // The tab strip and the status bar frame the panes; they are not the content a person jumps to.
  await expect(main(page).getByRole("tablist", { name: "Tabs" })).toHaveCount(0);
  await expect(page.getByRole("contentinfo")).toBeVisible();
  await expect(main(page).getByRole("contentinfo")).toHaveCount(0);
});

test("the first-run page has one main landmark, around its steps", async ({ page }) => {
  // No host chosen yet: the fixture's stored connection is removed before the app reads it.
  await page.addInitScript(() => localStorage.removeItem("doriface.connection"));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Join a mesh" })).toBeVisible({ timeout: 20_000 });
  await expect(main(page)).toHaveCount(1);
  await expect(main(page).getByRole("heading", { name: "Join a mesh" })).toBeVisible();
});

// Settings covers the workspace at every width and hides it from assistive tech, so its landmark is the modal dialog it
// is drawn in: one Settings dialog, and no main landmark beside or inside it.
for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test.describe(`Settings at ${viewport.width}`, () => {
    test.use({ viewport });

    test("Settings exposes one landmark, its modal dialog", async ({ page }) => {
      await page.goto("/settings");
      const settings = page.getByRole("dialog", { name: "Settings" });
      await expect(settings).toBeVisible({ timeout: 15_000 });
      await expect(settings).toHaveAttribute("aria-modal", "true");
      await expect(page.getByRole("dialog")).toHaveCount(1);
      await expect(settings.getByRole("heading", { name: "Settings" })).toBeVisible();
      await expect(main(page)).toHaveCount(0);
    });
  });
}

test.describe("on a phone", () => {
  const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
  test.use(phone);

  test("the agents list and then the open terminal sit in the one main landmark", async ({ page }) => {
    const address = startAgent("host", "landmark", "idle");
    try {
      await page.goto("/");
      const row = page.getByRole("button", { name: /landmark/ }).first();
      await expect(row).toBeVisible({ timeout: 20_000 });
      await expect(main(page)).toHaveCount(1);
      await expect(
        main(page)
          .getByRole("button", { name: /landmark/ })
          .first(),
      ).toBeVisible();
      await expect(main(page).getByRole("heading", { name: "Agents" })).toHaveCount(0);

      await row.click();
      await expect(page.getByRole("button", { name: "Back to agents" })).toBeVisible({ timeout: 20_000 });
      await expect(main(page)).toHaveCount(1);
      await expect(main(page).locator("[data-terminal]")).toBeVisible({ timeout: 20_000 });
      await expect(main(page).getByRole("button", { name: "Back to agents" })).toHaveCount(0);
    } finally {
      endAgent("host", address);
    }
  });
});
