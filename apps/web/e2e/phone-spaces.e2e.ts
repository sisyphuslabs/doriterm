import { devices } from "@playwright/test";
import { endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
test.use({ ...phone, serviceWorkers: "block" });

test("a space row on a phone opens that space's terminal", async ({ page }) => {
  const address = startAgent("host", "spacerow", "idle");
  try {
    await page.goto("/");
    expect(new URL(page.url()).search).toBe("");
    await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "Spaces" }).click();
    const spaces = page.getByRole("region", { name: "Spaces" });
    await expect(spaces).toBeVisible({ timeout: 20_000 });
    const row = spaces.getByRole("button", { name: /^api / }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    await expect.poll(() => new URL(page.url()).search, { timeout: 15_000 }).toContain("?t=");
    await expect(page.locator("[data-terminal]").first()).toBeVisible({ timeout: 20_000 });
  } finally {
    endAgent("host", address);
  }
});
