import { expect, test } from "./fixtures.ts";

// A narrow window under a mouse still draws the phone's list of sections (below md); there the touch treatment stays a
// touch one: the icons draw bare, as the Herdr desktop app draws them, and the rows keep the fine row's height, since the
// 44 px tap target and the coloured tiles are for a touch screen only (#892, #2914).
test.use({ viewport: { width: 600, height: 800 }, hasTouch: false, isMobile: false, serviceWorkers: "block" });

test("with a mouse the list's rows keep the fine row height and draw their icons bare (#2914)", async ({ page }) => {
  await page.goto("/settings");
  const row = page.locator("[data-settings-list]").getByRole("button", { name: "This device" });
  await expect(row).toBeVisible();
  const drawn = await row.evaluate((element) => {
    const tile = element.querySelector("[aria-hidden]");
    const root = getComputedStyle(document.documentElement);
    const rem = Number.parseFloat(root.fontSize);
    return {
      height: Math.round(element.getBoundingClientRect().height),
      min: Math.round(Number.parseFloat(root.getPropertyValue("--settings-row-min")) * rem),
      tile: tile === null ? "none" : getComputedStyle(tile).backgroundColor,
    };
  });
  expect(drawn.min).toBe(44);
  expect(drawn.height).toBeGreaterThanOrEqual(drawn.min);
  expect(drawn.height).toBeLessThan(52);
  expect(drawn.tile).toBe("rgba(0, 0, 0, 0)");
});
