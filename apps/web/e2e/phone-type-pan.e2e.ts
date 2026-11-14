import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { openChat, openPhoneTerminal, panViewport, PHONE } from "./phone-key-bar.ts";

test.use({ serviceWorkers: "block", ...PHONE });

const field = (page: Page) => page.getByLabel("Type into the terminal");
const bar = (page: Page) => page.getByRole("group", { name: "Chat" });
const focusedLabel = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? null);

async function typeFieldUp(page: Page): Promise<void> {
  await openPhoneTerminal(page);
  await openChat(page);
}

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
