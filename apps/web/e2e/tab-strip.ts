import type { Locator, Page } from "@playwright/test";
import { expect, laidOutBox, openNewTerminal } from "./fixtures.ts";
import { shortcut } from "./platform-keys.ts";

export const strip = (page: Page) => page.getByRole("tablist", { name: "Tabs" });
export const tabs = (page: Page) => strip(page).getByRole("tab");

/**
 * The strip's tab whose panel shows the terminal: a tab reads its name or its number, as herdr-app's, so a spec finds a
 * terminal's tab by what it shows. None (count 0) while that tab is not in the selected space.
 */
export async function tabOf(page: Page, address: string): Promise<Locator> {
  const panel = page.locator(`[role="tabpanel"]:has([data-terminal="${address}"])`);
  await expect(panel).toHaveCount(1, { timeout: 20_000 });
  const id = (await panel.getAttribute("id")) ?? "";
  return strip(page).locator(`[role="tab"][aria-controls="${id}"]`);
}
/** The selected tab's panel showing the terminal: none (count 0) while another tab is selected. */
export const selectedPane = (page: Page, address: string) =>
  page.locator(`[role="tabpanel"]:not([hidden]) [data-terminal="${address}"]`);
export const focusedAddress = (page: Page) =>
  page.locator('[data-focused="true"] [data-terminal]').getAttribute("data-terminal");
export const selectedIndex = (page: Page) =>
  tabs(page).evaluateAll((els) => els.findIndex((el) => el.getAttribute("aria-selected") === "true"));

/**
 * The number chord that selects a tab by its place, as the platform binds it: Cmd+N on a Mac, Ctrl+N elsewhere, as
 * herdr-app binds it (#702).
 */
export const tabNumberChord = (page: Page, place: number): Promise<string> => shortcut(page, `tab.select:${place}`);

/** The strip's order as the platform's number chords select each tab, then the tab that was selected is selected again. */
export async function order(page: Page): Promise<string[]> {
  const count = await tabs(page).count();
  const selected = await selectedIndex(page);
  const select = async (index: number) => {
    await page.keyboard.press(await tabNumberChord(page, index + 1));
    await expect(tabs(page).nth(index)).toHaveAttribute("aria-selected", "true");
  };
  const addresses = await Array.from({ length: count }, (_unused, index) => index).reduce<Promise<string[]>>(
    async (previous, index) => {
      const listed = await previous;
      await select(index);
      return [...listed, (await focusedAddress(page)) ?? ""];
    },
    Promise.resolve([]),
  );
  await select(selected);
  return addresses;
}

/** The strip's tab ids in DOM order, read without pressing a key. */
export const domOrder = (page: Page) =>
  strip(page)
    .locator("[data-tab-id]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-tab-id") ?? ""));

/** Four tabs, the last of them new and selected: the workspace opens one on its own when the core has a live one. */
export async function fourTabs(page: Page): Promise<string[]> {
  await openFour(page);
  return order(page);
}

export async function openFour(page: Page): Promise<void> {
  await page.goto("/");
  await openNewTerminal(page);
  const missing = 4 - (await tabs(page).count());
  await Array.from({ length: missing }).reduce<Promise<unknown>>(
    (previous) => previous.then(() => openNewTerminal(page)),
    Promise.resolve(),
  );
  await expect(tabs(page)).toHaveCount(4);
}

export const centre = async (locator: Locator) => {
  const box = await laidOutBox(locator);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, right: box.x + box.width };
};

export async function dragPast(page: Page, from: Locator, past: Locator): Promise<void> {
  const start = await centre(from);
  const end = await centre(past);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.right - 4, end.y, { steps: 16 });
  await page.mouse.up();
}

export const rearranged = (list: readonly string[], indexes: readonly number[]) => indexes.map((index) => list[index]);
