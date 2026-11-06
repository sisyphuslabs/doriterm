import { devices } from "@playwright/test";
import { endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
test.use({ ...phone, serviceWorkers: "block" });

test("the phone's Back returns to the list from a terminal, and only then leaves the app", async ({ page }) => {
  const address = startAgent("host", "backnav", "idle");
  try {
    await page.goto("/");
    const row = page.getByRole("button", { name: /backnav/ }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    await expect(page.getByRole("button", { name: "Back to agents" })).toBeVisible({ timeout: 20_000 });
    expect(new URL(page.url()).searchParams.get("t")).not.toBeNull();

    await page.goBack();
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get("t")).toBeNull();

    const before = page.url();
    await page.goBack();
    await expect.poll(() => page.url()).not.toBe(before);
    await expect(page.getByRole("button", { name: "Back to agents" })).toHaveCount(0);
    void address;
  } finally {
    endAgent("host", address);
  }
});
