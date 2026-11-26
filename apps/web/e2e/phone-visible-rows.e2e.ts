import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { gridSize } from "./core-size.ts";
import { expectTouchTargets, key, keysBar, openPhoneTerminal, settledGrid } from "./phone-key-bar.ts";

// A touch phone. The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block", hasTouch: true, isMobile: true });

/** An iPhone's home inset, which headless Chromium does not have: the page reads it through `--safe-bottom`. */
async function homeInset(page: Page, px: number): Promise<void> {
  await page.addInitScript((bottom) => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = `:root { --safe-bottom: ${bottom}px !important; }`;
      document.head.append(style);
    });
  }, px);
}

const rows = async (page: Page): Promise<number> =>
  Number((await gridSize(page.locator("[data-terminal]"))).split(" ")[0]);

/**
 * With the keyboard down, a phone terminal's bottom is its keys row on the home inset, as in the Herdr app: no tabs strip
 * under it and no row of its own for a round button (#2879). Before, 390x844 showed 37 rows and 844x390 showed 11.
 */
for (const { name, width, height, inset, least } of [
  { name: "portrait 390x844", width: 390, height: 844, inset: 34, least: 40 },
  { name: "landscape 844x390", width: 844, height: 390, inset: 21, least: 15 },
]) {
  test.describe(name, () => {
    test.use({ screen: { width: Math.min(width, height), height: Math.max(width, height) } });

    test(`a terminal in a tab shows at least ${least} rows with the keyboard down`, async ({ page }) => {
      await homeInset(page, inset);
      // Opened upright, then turned, as a phone is: a touch screen whose short side is a phone's keeps the phone shell.
      const terminal = await openPhoneTerminal(page, Math.min(width, height), "resize");
      await page.setViewportSize({ width, height });
      await expect(key(page, "Show keyboard")).toBeVisible();
      await settledGrid(page, terminal);
      expect(await rows(page)).toBeGreaterThanOrEqual(least);
      await expect(page.locator("[data-phone-tabs]").getByRole("button", { name: /^Switch tab, / })).toHaveText("1/1");
      const bar = await keysBar(page).boundingBox();
      expect(height - ((bar?.y ?? 0) + (bar?.height ?? 0))).toBe(inset);
      await expectTouchTargets(page.getByRole("banner"));
    });
  });
}
