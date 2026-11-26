// The top bar on a tablet in portrait (820 px wide, a finger for a pointer; #2872): Split right and Split down fold into
// one "Split pane" menu that still splits, and a strip that overflows shows "All tabs", which lists every tab and selects
// the one tapped. Both triggers keep a 44 px hit area on the coarse pointer.
import type { Locator, Page } from "@playwright/test";
import { startShell } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { fold } from "./fold.ts";
import { seedLayout } from "./layout-doc.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { openTabsUntilOverflow, strip, tabs, titlesIn } from "./tab-strip.ts";

endOwnTerminals();

test.use({ serviceWorkers: "block", hasTouch: true, isMobile: true });

const IPAD_PORTRAIT = { width: 820, height: 1180 } as const;
const TAG = "ttb-" + Date.now().toString(36);

/** Seeds one shell in its own tab, opens the tablet shell on it, and checks the pointer is a finger. */
async function openTabletOnShell(page: Page, name: string): Promise<void> {
  const address = startShell("host", `${TAG}-${name}`);
  seedLayout([{ id: `tb-${TAG}-${name}`, root: [{ pane: `p-${name}`, terminal: address, weight: 1 }] }]);
  await fold(page, IPAD_PORTRAIT);
  await page.goto("/");
  await expect(page.locator(`[data-terminal="${address}"]`)).toContainText("$", { timeout: 20_000 });
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
}

/** The control's hit area: its ::after box, which a coarse pointer grows to at least 44 px. */
const hitArea = (control: Locator) =>
  control.evaluate((el) => {
    const after = getComputedStyle(el, "::after");
    return { width: Number.parseFloat(after.width), height: Number.parseFloat(after.height) };
  });

test("at 820 with a finger, Split pane is one menu with Split right and Split down, and Split right splits the tab", async ({
  page,
}) => {
  await openTabletOnShell(page, "split");
  await expect(page.getByRole("button", { name: "Split right", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Split down", exact: true })).toHaveCount(0);

  const trigger = page.getByRole("button", { name: "Split pane", exact: true });
  await expect(trigger).toBeEnabled();
  const hit = await hitArea(trigger);
  expect(hit.width).toBeGreaterThanOrEqual(44);
  expect(hit.height).toBeGreaterThanOrEqual(44);

  await trigger.tap();
  const items = page.getByRole("menu").getByRole("menuitem");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveAccessibleName(/^Split right/);
  await expect(items.nth(1)).toHaveAccessibleName(/^Split down/);

  await items.nth(0).tap();
  await expect(page.locator('[role="tabpanel"]:not([hidden]) [data-terminal]')).toHaveCount(2, { timeout: 15_000 });
});

test("at 820 with a finger, an overflowing strip shows All tabs, which lists every tab and selects the one tapped", async ({
  page,
}) => {
  await openTabletOnShell(page, "tabs");
  const allTabs = page.getByRole("button", { name: "All tabs", exact: true });
  await expect(allTabs).toHaveCount(0);
  // One tab fits: no edge fades, and the Close button's 44 px hit area leaves the strip nothing to scroll.
  const scroller = strip(page).locator("[data-tab-scroll]");
  expect(
    await scroller.evaluate((el) => ({
      scrolls: el.scrollWidth > el.clientWidth,
      fades: el.hasAttribute("data-overflow-start") || el.hasAttribute("data-overflow-end"),
    })),
  ).toEqual({ scrolls: false, fades: false });

  await openTabsUntilOverflow(page, 16);
  await expect(allTabs).toBeVisible({ timeout: 10_000 });
  const hit = await hitArea(allTabs);
  expect(hit.width).toBeGreaterThanOrEqual(44);
  expect(hit.height).toBeGreaterThanOrEqual(44);

  const expectedTitles = await titlesIn(tabs(page));
  await expect(tabs(page).first()).toHaveAttribute("aria-selected", "false");
  await allTabs.tap();
  const items = page.getByRole("menu").getByRole("menuitem");
  await expect(items).toHaveCount(expectedTitles.length);
  expect(await titlesIn(items)).toEqual(expectedTitles);

  await items.first().tap();
  await expect(tabs(page).first()).toHaveAttribute("aria-selected", "true");
});
