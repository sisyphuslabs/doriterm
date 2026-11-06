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
// open, however a part reveals itself: on a touch screen an agent row keeps its More visible (#808; More alone since
// #950), and the row's actions were drawn over every Settings section (#879).
test("nothing the workspace draws shows through Settings on a touch screen, and leaving it draws the row again (#879)", async ({
  page,
}) => {
  const address = startAgent("host", "undersettings", "idle");
  try {
    await page.goto("/");
    const more = page.getByRole("button", { name: "More for undersettings" });
    await expect(more).toBeVisible({ timeout: 20_000 });

    await page
      .getByRole("link", { name: /Settings/ })
      .or(page.getByRole("button", { name: /Settings/ }))
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
    await expect.poll(() => drawnUnderSettings(page)).toEqual([]);

    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(more).toBeVisible();
  } finally {
    endAgent("host", address);
  }
});

// The report behind #879 was a dark Appearance screen on an Android phone: the workspace's agent row kept its Pin and
// More visible there and read as a second toolbar over the System/Light/Dark control. Same guard, the screen and theme
// the user actually saw, so a section-level regression cannot hide behind a light-only check.
test("the Appearance section keeps nothing of the workspace over it in dark (#879)", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const address = startAgent("host", "undersettings", "idle");
  try {
    await page.goto("/");
    await expect(page.getByRole("button", { name: /^Pin undersettings to the top$/ })).toBeVisible({
      timeout: 20_000,
    });
    await page
      .getByRole("link", { name: /Settings/ })
      .or(page.getByRole("button", { name: /Settings/ }))
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
    await page.getByRole("tab", { name: "Appearance" }).click();
    await expect(page.getByRole("heading", { name: "Appearance", exact: true })).toHaveCount(1);
    await expect.poll(() => drawnUnderSettings(page)).toEqual([]);
    // Queried by attribute, not by role: the workspace under Settings is aria-hidden, and getByRole skips it, so a role
    // query here could never fail whatever the workspace drew.
    await expect(page.locator('[aria-label^="Pin "]:visible')).toHaveCount(0);
    await expect(page.locator('[aria-label^="More for "]:visible')).toHaveCount(0);
  } finally {
    endAgent("host", address);
  }
});
