import type { Locator, Page } from "@playwright/test";
import { setCoreDoc } from "./core-doc.ts";
import { expect, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import { machineRow } from "./machine-switch.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });
/** The order is kept on both cores (#2531), shared by every spec on this worker: none is left for the next one. */
function clearOrders(): void {
  setCoreDoc("doriface", null);
  setCoreDoc("doriface", null, undefined, "machine");
}
test.beforeEach(clearOrders);
test.afterEach(clearOrders);

const rows = (page: Page) => page.locator("[data-machine-row]");
const list = (page: Page) => page.getByRole("heading", { name: "Spaces" }).locator("xpath=ancestor::section");
const order = (page: Page) =>
  rows(page).evaluateAll((els) => els.map((el) => el.querySelector("span[title]")?.getAttribute("title")));

async function centre(of: Locator): Promise<{ readonly x: number; readonly y: number; readonly bottom: number }> {
  const box = await of.boundingBox();
  if (box === null) throw new Error("no box");
  return { x: box.x + box.width / 3, y: box.y + box.height / 2, bottom: box.y + box.height };
}

/** Past the 300 ms hold that lifts a row under a finger. */
const TOUCH_LIFT_MS = 350;

/**
 * One finger through CDP, on a paused page clock so only the test decides when the hold has lasted: held (`hold`, the
 * clock runs past the lift) or not, then moved down to `y` (or left in place), then lifted. As the tab strip's touch
 * spec does it (tab-reorder-touch.e2e.ts).
 */
async function touch(page: Page, from: Locator, y: number | null, hold: boolean): Promise<void> {
  const start = await centre(from);
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 5_000);
  const cdp = await page.context().newCDPSession(page);
  const at = (py: number) => [{ x: start.x, y: py }];
  const t0 = Date.now() / 1000;
  const stamp = (ms: number) => t0 + ms / 1000;
  const movesFrom = hold ? TOUCH_LIFT_MS : 0;
  const steps = y === null ? 0 : 12;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(start.y), timestamp: stamp(0) });
  if (hold) {
    await page.clock.runFor(TOUCH_LIFT_MS);
    await expect(list(page).locator("[data-lifted]")).toHaveCount(1);
  }
  const target = y ?? start.y;
  await Array.from({ length: steps }, (_unused, index) => index + 1).reduce<Promise<unknown>>(
    (previous, step) =>
      previous.then(() =>
        cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: at(start.y + ((target - start.y) * step) / 12),
          timestamp: stamp(movesFrom + step * 8),
        }),
      ),
    Promise.resolve(),
  );
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
    timestamp: stamp(movesFrom + (steps + 1) * 8),
  });
  await cdp.detach();
  await page.clock.resume();
}

test.describe("touch (#161)", () => {
  test.use({ hasTouch: true });

  test("a held touch drags a machine, a quick swipe does not, and a hold let go opens the row's menu", async ({
    page,
  }) => {
    await page.clock.install();
    await page.goto("/");
    await expect(machineRow(page)).toContainText("connected", { timeout: 30_000 });
    // By name (#2531), the added machine (`build-box`) is listed above this core.
    const local = await rows(page).nth(1).locator("span[title]").getAttribute("title");
    if (local === null) throw new Error("no local machine row");
    await expect.poll(() => order(page)).toEqual([MACHINE_NAME, local]);
    const past = async () => (await centre(page.locator("[data-drag-id]").nth(1))).bottom - 4;

    await touch(page, rows(page).nth(0), await past(), false);
    await expect(list(page).locator("[data-lifted]")).toHaveCount(0);
    expect(await order(page)).toEqual([MACHINE_NAME, local]);

    await touch(page, rows(page).nth(0), await past(), true);
    await expect.poll(() => order(page)).toEqual([local, MACHINE_NAME]);

    await touch(page, rows(page).nth(0), null, true);
    await expect(page.getByRole("menuitem", { name: "Move down" })).toBeVisible();
    // The menu takes focus a frame after it shows; an Escape before that goes elsewhere and leaves it open.
    await expect(page.getByRole("menu")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(await order(page)).toEqual([local, MACHINE_NAME]);
  });
});
