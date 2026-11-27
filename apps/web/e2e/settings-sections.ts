import type { Locator, Page } from "@playwright/test";
import { expect } from "./fixtures.ts";

/**
 * A Settings section's entry where this width draws it: a button in the side navigation from `md` up, else a row in the
 * phone's list of sections (#2914). Hidden copies are out of the accessibility tree, so one of the two matches.
 */
export const settingsSection = (page: Page, name: string): Locator =>
  page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("button", { name, exact: true })
    .or(page.locator("[data-settings-list]").getByRole("button", { name, exact: true }));

/** The phone's Back from a section's page to the list of sections. */
export const settingsBack = (page: Page): Locator => page.getByRole("button", { name: "Settings", exact: true });

/** Opens a Settings section at any width: on a phone showing another section's page, by way of the list. */
export async function openSettingsSection(page: Page, name: string): Promise<void> {
  const entry = settingsSection(page, name);
  await expect(entry.or(settingsBack(page)).first()).toBeVisible();
  if (!(await entry.isVisible())) await settingsBack(page).click();
  await entry.click();
}
