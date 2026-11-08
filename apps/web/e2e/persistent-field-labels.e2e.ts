import { devices, type Locator } from "@playwright/test";
import { endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block" });

async function associatedLabel(field: Locator, name: string) {
  await expect(field).toHaveAttribute("aria-labelledby", /\S+/);
  const label = await field.evaluate((el) => {
    const target = document.getElementById(el.getAttribute("aria-labelledby") ?? "");
    return {
      text: target?.textContent?.trim(),
      isLabel: target instanceof HTMLLabelElement,
      forField: target instanceof HTMLLabelElement && el.id !== "" && target.htmlFor === el.id,
    };
  });
  expect(label).toEqual({ text: name, isLabel: true, forField: true });
}

for (const width of [390, 1440] as const) {
  test.describe(`${width}`, () => {
    const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
    test.use(width === 390 ? phone : { viewport: { width: 1440, height: 900 } });

    test("the palette keeps an associated Command label while typing (#1445)", async ({ page }) => {
      await page.goto("/");
      await page
        .getByRole("button", { name: width === 390 ? "Command palette" : /Commands/ })
        .first()
        .click();
      const field = page.getByRole("combobox", { name: "Command", exact: true });
      await expect(field).toBeFocused();
      await associatedLabel(field, "Command");
      await field.fill("settings");
      await expect(field).toHaveValue("settings");
      await associatedLabel(field, "Command");
    });
  });
}

test("inline rename keeps its associated label when the new name replaces the old one (#1445)", async ({ page }) => {
  const address = startAgent("host", "label-check", "idle", "website");
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const sidebar = page.getByRole("complementary", { name: "Workspace" });
    await sidebar.getByRole("button", { name: /^website\b/ }).dblclick();
    const field = sidebar.getByRole("textbox", { name: "Rename space website" });
    await expect(field).toBeFocused();
    await associatedLabel(field, "Rename space website");
    await field.fill("storefront");
    await expect(field).toHaveValue("storefront");
    await associatedLabel(field, "Rename space website");
    await field.press("Escape");
    await expect(field).toHaveCount(0);
  } finally {
    endAgent("host", address);
  }
});
