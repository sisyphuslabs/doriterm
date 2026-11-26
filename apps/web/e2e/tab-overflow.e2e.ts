// Top bar tab layout and horizontal overflow menu:
// - at 1440x900 with two tabs, "All tabs" is absent and New tab sits directly after the last tab;
// - at 700x900 once tabs overflow the scroller, "All tabs" appears, lists every tab title, and selects on click.
import type { Page } from "@playwright/test";
import { expect, laidOutBox, pressNewTab, test } from "./fixtures.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { strip, tabs } from "./tab-strip.ts";

endOwnTerminals();

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

const focusedTerminal = (page: Page) => page.locator('[data-focused="true"] [data-terminal]');

const openTerminal = async (page: Page, name: RegExp, text: string | RegExp): Promise<void> => {
  await page.getByRole("button", { name }).first().click();
  await expect(focusedTerminal(page)).toContainText(text, { timeout: 15_000 });
};

test("New tab sits next to the last tab at 1440, and All tabs appears and selects on overflow at 700", async ({
  page,
}) => {
  await page.goto("/");
  await openTerminal(page, /shell/, "$");
  await openTerminal(page, /review/, "Reading apps/relay/src/session.ts");
  await expect(tabs(page)).toHaveCount(2);

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
  const scroller = strip(page).locator("[data-tab-scroll]");
  const overflows = () => scroller.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  const openUntilOverflow = async (remaining: number): Promise<void> => {
    if (remaining <= 0 || (await overflows())) return;
    const before = await tabs(page).count();
    await pressNewTab(newTab);
    await expect(tabs(page)).toHaveCount(before + 1, { timeout: 15_000 });
    await openUntilOverflow(remaining - 1);
  };
  await openUntilOverflow(12);

  await expect(allTabs).toBeVisible({ timeout: 10_000 });

  const expectedTitles = await tabs(page).evaluateAll((els) =>
    els.map((el) => el.querySelector("span.truncate")?.textContent?.trim() ?? el.textContent?.trim() ?? ""),
  );
  await expect(tabs(page).first()).toHaveAttribute("aria-selected", "false");

  await allTabs.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const items = menu.getByRole("menuitem");
  await expect(items).toHaveCount(expectedTitles.length);
  const menuTitles = await items.evaluateAll((els) =>
    els.map((el) => el.querySelector("span.truncate")?.textContent?.trim() ?? ""),
  );
  expect(menuTitles).toEqual(expectedTitles);

  await items.first().click();
  await expect(tabs(page).first()).toHaveAttribute("aria-selected", "true");
});
