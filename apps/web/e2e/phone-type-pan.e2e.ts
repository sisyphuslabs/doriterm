import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { openPhoneTerminal, panViewport, PHONE } from "./phone-key-bar.ts";

test.use({ serviceWorkers: "block", ...PHONE });

const field = (page: Page) => page.getByLabel("Type into the terminal");
const focusedLabel = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? null);

async function typeFieldUp(page: Page): Promise<void> {
  const terminal = await openPhoneTerminal(page);
  await terminal.tap();
  await field(page).tap();
  await expect(field(page)).toBeFocused();
}

for (const px of [120, 336]) {
  test(`a ${px}px pan with the keyboard up keeps the Type field focused and inside the visual viewport`, async ({
    page,
  }) => {
    await typeFieldUp(page);
    await panViewport(page, px);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect(await focusedLabel(page)).toBe("Type into the terminal");
    const [box, vv] = await Promise.all([
      field(page).boundingBox(),
      page.evaluate(() => ({ top: window.visualViewport?.offsetTop ?? 0, height: window.visualViewport?.height ?? 0 })),
    ]);
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(vv.top);
    expect((box?.y ?? 0) + (box?.height ?? Infinity)).toBeLessThanOrEqual(vv.top + vv.height);
  });
}
