import { devices, type Page } from "@playwright/test";
import { endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
// The full iPhone 14 screen, so the captures show the bottom bar where a phone draws it.
test.use({ ...phone, viewport: { width: 390, height: 844 }, serviceWorkers: "block" });

const tabs = (page: Page) => page.getByRole("navigation", { name: "Sections" });
const capture = process.env["NAV_CAPTURE_DIR"];
const shoot = async (page: Page, name: string): Promise<void> => {
  if (capture === undefined) return;
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity))
        .map((animation) => animation.finished),
    ),
  );
  await page.screenshot({ path: `${capture}/${name}.png` });
};

test("the phone's bottom tabs swap Agents and Spaces in place and keep the choice", async ({ page }) => {
  const address = startAgent("host", "tabbar", "idle");
  try {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
    await expect(tabs(page).getByRole("button", { name: "Agents" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: /tabbar/ }).first()).toBeVisible({ timeout: 15_000 });
    const url = page.url();
    const depth = await page.evaluate(() => window.history.length);

    await tabs(page).getByRole("button", { name: "Spaces" }).click();
    await expect(page.getByRole("heading", { name: "Spaces", level: 1 })).toBeVisible();
    await expect(page.locator("[data-phone-home=spaces]")).toBeVisible();
    await expect(page.locator("[data-phone-home=agents]")).toHaveCount(0);
    await expect(tabs(page).getByRole("button", { name: "Spaces" })).toHaveAttribute("aria-current", "page");
    expect(page.url()).toBe(url);
    expect(await page.evaluate(() => window.history.length)).toBe(depth);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Spaces", level: 1 })).toBeVisible({ timeout: 20_000 });

    await tabs(page).getByRole("button", { name: "Agents" }).click();
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
    await expect(page.locator("[data-phone-home=spaces]")).toHaveCount(0);

    await tabs(page)
      .getByRole("link", { name: /^Settings/ })
      .click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/settings");
  } finally {
    endAgent("host", address);
  }
});

async function openSpaceAndReturn(page: Page, scheme: "light" | "dark"): Promise<void> {
  {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /navdocs/ }).first()).toBeVisible({ timeout: 15_000 });
    await shoot(page, `agents-${scheme}`);

    await tabs(page).getByRole("button", { name: "Spaces" }).click();
    const spaces = page.getByRole("region", { name: "Spaces" });
    const row = spaces.getByRole("button", { name: /^docs / }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await shoot(page, `spaces-${scheme}`);

    await row.click();
    await expect.poll(() => new URL(page.url()).search, { timeout: 15_000 }).toContain("?t=");
    await expect(page.locator("[data-terminal]").first()).toBeVisible({ timeout: 20_000 });
    await shoot(page, `space-opened-${scheme}`);

    await page.getByRole("button", { name: "Back to agents" }).click();
    await expect(page.getByRole("heading", { name: "Spaces", level: 1 })).toBeVisible();
    await expect(spaces.getByRole("button", { name: /^docs / }).first()).toHaveAttribute("aria-current", "true");
    await expect(spaces.getByRole("button", { name: /^api / }).first()).not.toHaveAttribute("aria-current", "true");
    await shoot(page, `spaces-selected-${scheme}`);
    await tabs(page).getByRole("button", { name: "Agents" }).click();
  }
}

test("the selected space row is the space whose terminal the phone last opened", async ({ page }) => {
  const api = startAgent("host", "navapi", "working", "api");
  const docs = startAgent("host", "navdocs", "idle", "docs");
  try {
    await openSpaceAndReturn(page, "light");
    await openSpaceAndReturn(page, "dark");
  } finally {
    endAgent("host", api);
    endAgent("host", docs);
  }
});
