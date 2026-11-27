import { expect, test } from "./fixtures.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

// Back on a touch phone pops the history at once and slides an inert copy of the screen left off over the list (#2787).

test.use({ serviceWorkers: "block", ...PHONE });

endOwnTerminals();

test("Back slides the terminal screen off over the list, then leaves nothing behind", async ({ page }) => {
  await openPhoneTerminal(page);
  // The watch is in place before Back is pressed, however slow the page is.
  const watch = await page.evaluateHandle(() => ({
    slid: new Promise<{ readonly inert: boolean; readonly duration: number; readonly named: number }>((resolve) => {
      new MutationObserver((records, observer) => {
        for (const node of records.flatMap((record) => [...record.addedNodes])) {
          if (!(node instanceof HTMLElement) || !node.hasAttribute("data-leaving")) continue;
          observer.disconnect();
          const [slide] = node.getAnimations();
          resolve({
            inert: node.inert,
            duration: Number(slide?.effect?.getComputedTiming().duration ?? 0),
            // A picture names nothing: a query for the live terminal finds only the live one (#2796 full).
            named: node.querySelectorAll("[data-terminal], [role], [id], [aria-label]").length,
          });
        }
      }).observe(document.body, { childList: true });
    }),
  }));
  await page.getByRole("button", { name: "Back to agents" }).click();
  // The list is there at once, under the sliding copy.
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  expect(await watch.evaluate((armed) => armed.slid)).toEqual({ inert: true, duration: 200, named: 0 });
  await expect(page.locator("[data-leaving]")).toHaveCount(0);
});

test("under reduced motion Back only pops: no copy slides", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openPhoneTerminal(page);
  await page.evaluate(() => {
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof HTMLElement && node.hasAttribute("data-leaving")) Reflect.set(window, "__ghost", true);
    }).observe(document.body, { childList: true });
  });
  await page.getByRole("button", { name: "Back to agents" }).click();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "__ghost") === true)).toBe(false);
});
