import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { openFour, order, rearranged, tabs } from "./tab-strip.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const TITLE = "The tab selection was not saved";

/** How many times that toast has been put up since the page loaded; a toast closes on its own, so it is counted. */
const timesSaid = (page: Page) => page.evaluate(() => Reflect.get(window, "notSavedCount") as number);

test("a storage that refuses this screen's view says its tab selection was not saved, once, and the tabs still move", async ({
  page,
}) => {
  // Every write of this screen's view is refused, as a full or denied storage refuses it; other settings still save.
  await page.addInitScript((title) => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith("doriface.view.")) throw new DOMException("the quota has been exceeded", "QuotaExceededError");
      setItem.call(this, key, value);
    };
    Reflect.set(window, "notSavedCount", 0);
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          const said = [node, ...node.querySelectorAll("*")].filter(
            (el) => el.childElementCount === 0 && el.textContent === title,
          );
          Reflect.set(window, "notSavedCount", (Reflect.get(window, "notSavedCount") as number) + said.length);
        }
      }
    }).observe(document, { childList: true, subtree: true });
  }, TITLE);
  // The first save is the page's own, on load: the toast is up at once, before it closes on its own.
  await page.goto("/");
  await expect(page.getByText(TITLE, { exact: true })).toBeVisible();
  await expect(page.getByText("the quota has been exceeded. This window keeps it until it reloads.")).toBeVisible();

  await openFour(page);
  await expect.poll(() => timesSaid(page)).toBe(1);

  const before = await order(page);
  const mac = await page.evaluate(() => navigator.platform.startsWith("Mac"));
  await tabs(page).nth(0).focus();
  await page.keyboard.press(mac ? "Meta+Shift+ArrowRight" : "Control+Alt+Shift+PageDown");
  await expect(tabs(page).nth(1)).toBeFocused();
  expect(await order(page)).toEqual(rearranged(before, [1, 0, 2, 3]));
  // The move itself is the document's (#404); the selection and focus it leaves wrote the view again and were refused
  // again, and a write that keeps failing is said once, not per change.
  expect(await timesSaid(page)).toBe(1);
});
