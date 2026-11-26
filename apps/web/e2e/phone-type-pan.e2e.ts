import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { key, openPhoneTerminal, panViewport, PHONE } from "./phone-key-bar.ts";

test.use({ serviceWorkers: "block", ...PHONE });

const field = (page: Page) => page.getByLabel("Type into the terminal");
const bar = (page: Page) => page.getByRole("toolbar", { name: "Terminal keys" });
const focusedLabel = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? null);

async function typeFieldUp(page: Page): Promise<void> {
  const terminal = await openPhoneTerminal(page);
  await terminal.tap();
  await key(page, "Type in a field").tap();
  await expect(field(page)).toBeFocused();
}

// An installed iOS app scrolls the document itself to show a focused field, and it may do so after the keyboard's last
// resize. WebKit fires no visualViewport event for a scroll of the document alone (its offsetTop and size do not
// change), so a keyboard measured only on those events kept that scroll's height between the keys and the keyboard.
test("a document scroll after the keyboard is up keeps the bar on the keyboard", async ({ page }) => {
  await typeFieldUp(page);
  await page.evaluate(() => {
    document.body.style.paddingBottom = "400px";
    window.scrollTo(0, 49);
  });
  expect(await page.evaluate(() => window.scrollY)).toBe(49);
  const vv = await page.evaluate(() => (window.visualViewport?.offsetTop ?? 0) + (window.visualViewport?.height ?? 0));
  await expect
    .poll(async () => {
      const box = await bar(page).boundingBox();
      return box === null ? null : Math.round(box.y + box.height);
    })
    .toBe(vv);
});

for (const px of [120, 336]) {
  test(`a ${px}px pan with the keyboard up keeps the Type field focused and inside the visual viewport`, async ({
    page,
  }) => {
    await typeFieldUp(page);
    await panViewport(page, px);
    const vv = await page.evaluate(() => ({
      top: window.visualViewport?.offsetTop ?? 0,
      height: window.visualViewport?.height ?? 0,
    }));
    expect(vv.top).toBe(px);
    // The bar re-lays out to the panned viewport's bottom: one left where it was before the pan is still on screen, so
    // only its bottom reaching the new edge tells the two apart.
    await expect
      .poll(async () => {
        const box = await bar(page).boundingBox();
        return box === null ? null : Math.round(box.y + box.height);
      })
      .toBe(vv.top + vv.height);
    expect(await focusedLabel(page)).toBe("Type into the terminal");
    const box = await field(page).boundingBox();
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(vv.top);
  });
}
