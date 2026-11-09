// The time from a click on the selected tab's Close to its question on screen (#560): flood-input.e2e.ts holds that
// every click is answered, and the render bench's Close prompt metric (bench/close-prompt.ts, #986) is this time.
import { type Page, errors } from "@playwright/test";

/**
 * From a real click on the selected tab's close button to its question on screen, in the page's own clock: the
 * pointerdown's timeStamp is when the browser took the input, so time the click waited behind a busy main thread counts,
 * and the driver's round trip does not. Null when the question has not come within `timeout` ms of the click. The
 * question stays open.
 */
export async function clickToDialog(page: Page, timeout = 10_000): Promise<number | null> {
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
  const box = await page
    .locator("[data-tab-id]")
    .filter({ has: page.getByRole("tab", { selected: true }) })
    .locator("[data-tab-close]")
    .boundingBox();
  if (box === null) throw new Error("no close button");
  // The mouse at the button's centre, not a locator click: that one first checks the hit target in the page, which waits
  // behind the very main thread this measures.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const probe = page.waitForFunction(
    () => {
      const { pressed, asked } = Reflect.get(window, "closeProbe") as { pressed: number; asked: number };
      return asked > 0 && pressed > 0 ? asked - pressed : null;
    },
    undefined,
    { timeout },
  );
  return probe
    .then((handle) => handle.jsonValue() as Promise<number>)
    .catch((error: unknown) => {
      if (error instanceof errors.TimeoutError) return null;
      throw error;
    });
}
