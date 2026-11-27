import type { Page } from "@playwright/test";
import { expect, laidOutBox, test } from "./fixtures.ts";
import { gridSize } from "./core-size.ts";
import { expectTouchTargets, key, keysBar, openPhoneTerminal, settledGrid } from "./phone-key-bar.ts";

// A touch phone. The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block", hasTouch: true, isMobile: true });

/** An iPhone's home inset, which headless Chromium does not have: the page reads it through `--safe-bottom`. */
async function homeInset(page: Page, px: number): Promise<void> {
  await page.addInitScript((bottom) => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = `:root { --safe-bottom: ${bottom}px !important; }`;
      document.head.append(style);
    });
  }, px);
}

const rows = async (page: Page): Promise<number> =>
  Number((await gridSize(page.locator("[data-terminal]"))).split(" ")[0]);

/**
 * With the keyboard down, a phone terminal's bottom is its keys row on the home inset, as in the Herdr app: no tabs strip
 * under it and no row of its own for a round button (#2879). The terminal takes everything from the header down to the
 * keys, and its grid fills it; how many rows that is follows the platform's font (on a Mac 390x844 went from 37 to 41
 * rows and 844x390 from 11 to 15).
 */
for (const { name, width, height, inset } of [
  { name: "portrait 390x844", width: 390, height: 844, inset: 34 },
  { name: "landscape 844x390", width: 844, height: 390, inset: 21 },
]) {
  test.describe(name, () => {
    test.use({ screen: { width: Math.min(width, height), height: Math.max(width, height) } });

    test("a terminal in a tab takes the screen from its header to its keys, the keys on the home inset", async ({
      page,
    }) => {
      await homeInset(page, inset);
      // Opened upright, then turned, as a phone is: a touch screen whose short side is a phone's keeps the phone shell.
      const terminal = await openPhoneTerminal(page, Math.min(width, height), "resize");
      await page.setViewportSize({ width, height });
      await expect(key(page, "Show keyboard")).toBeVisible();
      await settledGrid(page, terminal);
      const [header, screen, bar] = await Promise.all([
        laidOutBox(page.getByRole("banner")),
        laidOutBox(terminal),
        laidOutBox(keysBar(page)),
      ]);
      expect(Math.abs(bar.y + bar.height - (height - inset))).toBeLessThanOrEqual(1);
      expect(Math.abs(screen.y - (header.y + header.height))).toBeLessThanOrEqual(1);
      expect(Math.abs(screen.y + screen.height - bar.y)).toBeLessThanOrEqual(1);
      const row = await laidOutBox(terminal.locator(".term-row:not(.term-scrollback-row)").first());
      expect(screen.height - (await rows(page)) * row.height).toBeLessThan(row.height + 8);
      // The header keeps one 48 px line; the tabs chip is in it only on a phone on its side (#2879).
      expect(header.height).toBe(48);
      const chip = page
        .getByRole("banner")
        .locator("[data-phone-tabs]")
        .getByRole("button", { name: /^Switch tab, / });
      if (width < 430) await expect(chip).toHaveCount(0);
      else await expect(chip).toHaveText("1/1");
      await expectTouchTargets(page.getByRole("banner"));
    });
  });
}

/**
 * One tabs switch at every width: the header's chip from 430 px, the session sheet's Tabs row below it, never both and
 * never neither (Tailwind's max-[430px] is width < 430, the exact complement of min-[430px]).
 */
for (const width of [429, 430]) {
  test(`at ${width} px exactly one tabs switch is drawn`, async ({ page }) => {
    await openPhoneTerminal(page, width, "resize");
    const header = page.getByRole("banner");
    const chip = header.locator("[data-phone-tabs]").getByRole("button", { name: /^Switch tab, / });
    // The chip is read first: an open sheet is modal, and hides the header from the accessibility tree.
    if (width < 430) await expect(chip).toHaveCount(0);
    else await expect(chip).toBeVisible();
    await header.getByRole("button", { name: /^Session actions for / }).click();
    const row = page.getByRole("dialog").getByRole("button", { name: /^Switch tab, / });
    await expect(page.getByRole("dialog")).toBeVisible();
    if (width < 430) await expect(row).toBeVisible();
    else await expect(row).toHaveCount(0);
  });
}
