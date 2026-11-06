import { devices, type Page } from "@playwright/test";
import { endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
test.use({ ...phone, serviceWorkers: "block" });

/** Every element of the workspace kept under Settings (#607) whose own computed visibility would paint it. */
const drawnUnderSettings = (page: Page) =>
  page
    .locator("[inert] *")
    .evaluateAll((elements) =>
      elements
        .filter((element) => getComputedStyle(element).visibility !== "hidden")
        .map((element) => element.getAttribute("aria-label") ?? element.tagName.toLowerCase()),
    );

// Settings paints over a workspace it keeps mounted and hidden, so nothing of that workspace may be drawn while it is
// open, however a part reveals itself: on a touch screen an agent row keeps its Pin and More visible (#808), and those
// were drawn over every Settings section (#879), which read as a second toolbar over the Appearance control.
test("nothing the workspace draws shows through Settings on a touch screen, and leaving it draws the row again (#879)", async ({
  page,
}) => {
  const address = startAgent("host", "undersettings", "idle");
  try {
    await page.goto("/");
    const pin = page.getByRole("button", { name: /^Pin undersettings to the top$/ });
    await expect(pin).toBeVisible({ timeout: 20_000 });

    await page
      .getByRole("link", { name: /Settings/ })
      .or(page.getByRole("button", { name: /Settings/ }))
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
    await expect.poll(() => drawnUnderSettings(page)).toEqual([]);

    await page.getByRole("tab", { name: "Appearance" }).click();
    await expect(page.getByRole("heading", { name: "Appearance", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^Pin .+ to the top$/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^More for / })).toHaveCount(0);

    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(pin).toBeVisible();
  } finally {
    endAgent("host", address);
  }
});
