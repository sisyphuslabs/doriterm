// Top bar tab layout and horizontal overflow menu:
// - at 1440x900 with two tabs, "All tabs" is absent and New tab sits directly after the last tab;
// - at 700x900 once tabs overflow the scroller, "All tabs" appears, lists every tab title, and selects on click.
import type { Page } from "@playwright/test";
import { expect, laidOutBox, test } from "./fixtures.ts";
import { agentRow, endAgent, startShell } from "./agents.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { openTabsUntilOverflow, strip, tabs, titlesIn } from "./tab-strip.ts";

endOwnTerminals();

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

const focusedTerminal = (page: Page) => page.locator('[data-focused="true"] [data-terminal]');

// The spec seeds its own two shells, so it never depends on what other specs leave running.
const TAG = "tov-" + Date.now().toString(36);
let seeded: string[] = [];
test.afterEach(() => {
  for (const address of seeded) endAgent("host", address);
  seeded = [];
});

const openTerminal = async (page: Page, name: string): Promise<void> => {
  await agentRow(page, name, false).click({ timeout: 20_000 });
  await expect(focusedTerminal(page)).toContainText("$", { timeout: 15_000 });
};

test("New tab sits next to the last tab at 1440, and All tabs appears and selects on overflow at 700", async ({
  page,
}) => {
  seeded = [startShell("host", TAG + "-a"), startShell("host", TAG + "-b")];
  await page.goto("/");
  await openTerminal(page, TAG + "-a");
  await openTerminal(page, TAG + "-b");
  await expect.poll(() => tabs(page).count()).toBeGreaterThanOrEqual(2);

  const allTabs = page.getByRole("button", { name: "All tabs", exact: true });
  const newTab = page.getByRole("button", { name: "New tab", exact: true });
  await expect(allTabs).toHaveCount(0);

  await expect
    .poll(async () => {
      const last = await laidOutBox(strip(page).locator("[data-tab-id]").last());
      const plus = await laidOutBox(newTab);
      return plus.x - (last.x + last.width);
    })
    .toBeLessThanOrEqual(8);

  const lastBox = await laidOutBox(strip(page).locator("[data-tab-id]").last());
  const plusBox = await laidOutBox(newTab);
  expect(plusBox.x).toBeGreaterThanOrEqual(lastBox.x + lastBox.width);

  await page.setViewportSize({ width: 700, height: 900 });
  await openTabsUntilOverflow(page, 12);

  await expect(allTabs).toBeVisible({ timeout: 10_000 });

  const expectedTitles = await titlesIn(tabs(page));
  await expect(tabs(page).first()).toHaveAttribute("aria-selected", "false");

  await allTabs.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const items = menu.getByRole("menuitem");
  await expect(items).toHaveCount(expectedTitles.length);
  expect(await titlesIn(items)).toEqual(expectedTitles);

  await items.first().click();
  await expect(tabs(page).first()).toHaveAttribute("aria-selected", "true");
});
