import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import {
  hcOn,
  OFFLINE_BOUND_MS,
  OFFLINE_TEST_TIMEOUT_MS,
  reconnect,
  STATE_BOUND_MS,
  switchTo,
} from "./machine-switch.ts";

// Settings > Machines on a 390 px phone (#2456 review): a row with nothing to do is only its text, and an offline row
// with a long name keeps Try again and Remove… inside the screen, under its description.

test.use({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });

const LONG = "remote-build-machine-number-0001";

async function openMachines(page: Page): Promise<Locator> {
  await page.goto("/settings");
  await page.getByRole("tab", { name: "Machines" }).click();
  const list = page.getByRole("list", { name: "Machines" });
  await expect(list).toBeVisible();
  return list;
}

/** The row's height past its padding, less its text block's: 0 when the row is only its text. */
const extraHeight = (row: Locator): Promise<number> =>
  row.locator("[data-setting-row]").evaluate((element) => {
    const style = getComputedStyle(element);
    const inner = element.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom);
    const text = element.firstElementChild;
    return text === null ? Number.NaN : inner - text.getBoundingClientRect().height;
  });

test("a row with no control is only its text: no empty control line under it", async ({ page }) => {
  const list = await openMachines(page);
  const own = list.getByRole("listitem").filter({ hasText: "studio" });
  await expect(own).toContainText("Online");
  expect(await extraHeight(own)).toBeCloseTo(0, 0);
});

test.describe("an offline machine with a long name", () => {
  test.beforeEach(() => {
    hcOn("host", ["machine", "rename", MACHINE_NAME, LONG]);
  });
  test.afterEach(() => {
    hcOn("host", ["machine", "rename", LONG, MACHINE_NAME]);
    reconnect();
  });

  test("keeps Try again and Remove… inside the screen, under its description", async ({ page }) => {
    test.setTimeout(OFFLINE_TEST_TIMEOUT_MS);
    const list = await openMachines(page);
    const row = list.getByRole("listitem").filter({ hasText: LONG });
    await expect(row).toBeVisible({ timeout: STATE_BOUND_MS });
    switchTo("drop");
    await expect(row).toContainText("Offline", { timeout: OFFLINE_BOUND_MS });
    const setting = row.locator("[data-setting-row]");
    expect(await setting.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    const text = await setting.locator(":scope > div").first().boundingBox();
    for (const name of ["Try again", `Remove ${LONG}\u2026`]) {
      const button = await row.getByRole("button", { name, exact: true }).boundingBox();
      expect(button, name).not.toBeNull();
      if (button === null || text === null) continue;
      expect(button.x + button.width, name).toBeLessThanOrEqual(390);
      expect(button.y, name).toBeGreaterThanOrEqual(text.y + text.height);
    }
  });
});
