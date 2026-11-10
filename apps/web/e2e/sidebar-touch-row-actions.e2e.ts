import type { Page } from "@playwright/test";
import { endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { rows } from "./sidebar-measure.ts";

// A desktop window whose primary pointer is a finger: the shell stays the wide one, while the sidebar draws what a touch
// screen can reach without a hover (#950, #992).
test.use({
  serviceWorkers: "block",
  viewport: { width: 1280, height: 720 },
  hasTouch: true,
  isMobile: false,
  deviceScaleFactor: 1,
});

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Workspace" });

test("on a touch pointer, ArrowRight from a desktop sidebar row reaches More and ArrowLeft returns to the row", async ({
  page,
}) => {
  const address = startAgent("host", "touchrow", "idle");
  try {
    await page.goto("/");
    // The coarse layout follows the pointer, not the window: the desktop shell stays, and its rows show their actions.
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const row = rows(sidebar(page).getByRole("region", { name: "Idle", exact: true }))
      .filter({ hasText: "touchrow" })
      .first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    const more = page.getByRole("button", { name: "More for touchrow" });
    await expect(more).toBeVisible();
    // A touch screen draws More alone, so ArrowRight skips the Pin it does not draw instead of landing on it.
    await expect(page.getByRole("button", { name: "Pin touchrow to the top" })).toBeHidden();

    await row.focus();
    await page.keyboard.press("ArrowRight");
    await expect(more).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(row).toBeFocused();
  } finally {
    endAgent("host", address);
  }
});
