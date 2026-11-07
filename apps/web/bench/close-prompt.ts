// The render bench's Close prompt metric (#986): #560's budget, a Close question on screen within 200 ms of the click
// while terminals write, measured on the bench's runner instead of in the required Web e2e, where a shared, loaded
// runner made it measure how much CPU the page got.
import type { Page } from "@playwright/test";
import { expect } from "../e2e/fixtures.ts";

/** Clicks on the bench tab's Close per run; their median is the metric. */
export const CLOSE_CLICKS = 5;

/**
 * From a real click on the selected tab's close button to its question on screen, in the page's own clock: the
 * pointerdown's timeStamp is when the browser took the input, so time the click waited behind a busy main thread counts,
 * and the driver's round trip does not. Then Cancel, so the tab stays.
 */
export async function closePrompt(page: Page): Promise<number> {
  await page.evaluate(() => {
    const probe = { pressed: 0, asked: 0 };
    Object.assign(window, { closeProbe: probe });
    document.addEventListener("pointerdown", (event) => (probe.pressed = event.timeStamp), {
      capture: true,
      once: true,
    });
    const seen = new MutationObserver(() => {
      if (document.querySelector('[role="dialog"]') === null) return;
      seen.disconnect();
      probe.asked = performance.now();
    });
    seen.observe(document.body, { childList: true, subtree: true });
  });
  await page
    .locator("[data-tab-id]")
    .filter({ has: page.getByRole("tab", { selected: true }) })
    .locator("[data-tab-close]")
    .click();
  const dialog = page.getByRole("dialog", { name: /^Close/ });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  const { pressed, asked } = await page.evaluate(
    () => Reflect.get(window, "closeProbe") as { pressed: number; asked: number },
  );
  if (pressed === 0 || asked === 0) throw new Error("the Close click or its question was not seen by the page");
  return asked - pressed;
}
