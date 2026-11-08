import { devices } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
test.use({ ...phone, serviceWorkers: "block" });

test("the phone Gateway requests URL entry without text corrections (#1444)", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("tab", { name: "This device" }).click();
  const gateway = page.getByRole("textbox", { name: "Gateway", exact: true });
  await expect(gateway).toBeVisible();
  await expect(gateway).toHaveAttribute("inputmode", "url");
  await expect(gateway).toHaveAttribute("autocapitalize", "off");
  await expect(gateway).toHaveAttribute("autocorrect", "off");
  await expect(gateway).toHaveAttribute("spellcheck", "false");
  await expect(page.getByLabel("Token", { exact: true })).not.toHaveAttribute("inputmode", "url");
});
