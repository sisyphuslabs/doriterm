import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// An iPhone in portrait: the notch above, the home indicator below. With viewport-fit=cover Safari draws the page under
// both and reports them through env(safe-area-inset-*); the phone layout's fixed rows must sit clear of them (#562).
const INSETS = { top: 47, right: 0, bottom: 34, left: 0 };
const SIZE = { width: 390, height: 844 };

test.use({ serviceWorkers: "block", viewport: SIZE });

async function portraitWithInsets(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: INSETS });
}

/** The control's box, and whether a tap at its centre reaches it rather than whatever is drawn over it. */
async function reach(control: Locator): Promise<{ top: number; bottom: number; hit: boolean }> {
  return control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      top: Math.round(box.top),
      bottom: Math.round(box.bottom),
      hit: top !== null && (top === element || element.contains(top)),
    };
  });
}

async function expectClear(control: Locator): Promise<void> {
  const at = await reach(control);
  expect(at.top).toBeGreaterThanOrEqual(INSETS.top);
  expect(at.bottom).toBeLessThanOrEqual(SIZE.height - INSETS.bottom);
  expect(at.hit).toBe(true);
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`a portrait phone with a notch, ${colorScheme}`, () => {
    test.use({ colorScheme });

    test("the agents list keeps its header below the notch and its status bar above the home indicator", async ({
      page,
    }) => {
      await portraitWithInsets(page);
      await page.goto("/");
      const header = page.getByRole("banner");
      await expect(header.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
      await Promise.all([
        expectClear(header.getByRole("button", { name: "Command palette" })),
        expectClear(header.getByRole("button", { name: "New tab" })),
        expectClear(header.getByRole("link", { name: /^Settings/ })),
      ]);
      // The status bar's background may run under the home indicator; its words must sit above it.
      const words = await page
        .getByRole("contentinfo")
        .locator(":scope > div")
        .first()
        .evaluate((row) => Math.round(row.getBoundingClientRect().bottom));
      expect(words).toBeLessThanOrEqual(SIZE.height - INSETS.bottom);

      // A real tap on the header lands: Settings opens, and so does a new terminal from New tab.
      await header.getByRole("link", { name: /^Settings/ }).click();
      await expect(page).toHaveURL(/\/settings$/);
      await page.goBack();
      await expect(header.getByRole("heading", { name: "Agents" })).toBeVisible();
      await header.getByRole("button", { name: "New tab" }).click();
      await expect(page.getByRole("button", { name: "Back to agents" })).toBeVisible({ timeout: 20_000 });
      await expectClear(page.getByRole("button", { name: "Back to agents" }));
    });

    test.describe("on a touch screen", () => {
      // Touch layouts swap the esc hint for a Cancel button, which must clear the notch too.
      test.use({ hasTouch: true, isMobile: true });

      test("the command palette opens below the notch", async ({ page }) => {
        await portraitWithInsets(page);
        await page.goto("/");
        const header = page.getByRole("banner");
        await expect(header.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
        await header.getByRole("button", { name: "Command palette" }).click();
        const palette = page.getByRole("dialog", { name: "Command palette" });
        await expect(palette.getByRole("combobox", { name: "Command" })).toBeFocused();
        await Promise.all([
          expectClear(palette.getByRole("combobox", { name: "Command" })),
          expectClear(palette.getByRole("button", { name: "Cancel" })),
        ]);
      });
    });
  });
}
