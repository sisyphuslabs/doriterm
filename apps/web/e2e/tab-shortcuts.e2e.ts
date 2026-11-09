// The number chords select the tab at that place in the strip, as herdr-app's `tab.select:N`, split or not. A tab has no
// tooltip to advertise its chord, as in herdr-app's tabs mod (#466 ruling A); Settings > Keybindings lists them.
import type { Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { tabNumberChord, tabs } from "./tab-strip.ts";

endOwnTerminals();

test.use({ serviceWorkers: "block" });

/** Presses the platform's number chord for each tab in turn and checks that it selected the Nth tab. */
async function pressEach(page: Page): Promise<void> {
  const count = Math.min(9, await tabs(page).count());
  await Array.from({ length: count }, (_unused, index) => index).reduce<Promise<void>>(async (previous, index) => {
    await previous;
    await page.locator('[data-focused="true"] [data-terminal]').getByRole("textbox").focus();
    await page.keyboard.press(await tabNumberChord(page, index + 1));
    await expect(tabs(page).nth(index)).toHaveAttribute("aria-selected", "true");
  }, Promise.resolve());
}

test("each number chord selects the tab at that place, split or not, and no tab has a tooltip", async ({ page }) => {
  await page.goto("/");
  await openNewTerminal(page);
  await openNewTerminal(page);
  await openNewTerminal(page);
  expect(await tabs(page).count()).toBeGreaterThanOrEqual(3);
  await expect(tabs(page).and(page.locator("[title]"))).toHaveCount(0);
  await pressEach(page);

  // A split adds a pane to the tab in view, not a tab, so every tab keeps its place.
  await page.getByRole("button", { name: "Split right" }).click();
  await pressEach(page);
});
