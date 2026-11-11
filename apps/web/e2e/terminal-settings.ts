import type { Page } from "@playwright/test";
import { expect } from "./fixtures.ts";

/** Opens Terminal settings from the workspace. */
export async function openTerminalSettings(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
}

/** Closes Settings and returns to the workspace. */
export async function closeSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Close settings" }).first().click();
}

/**
 * Turns Copy on selection on (off by default) and returns to the terminal. The row keeps its plain label and shows the
 * Ghostty key it writes beneath it (DESIGN.md, Settings: Terminal).
 */
export async function enableCopyOnSelection(page: Page): Promise<void> {
  await openTerminalSettings(page);
  const toggle = page.getByRole("switch", { name: "Copy on selection", exact: true });
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  await closeSettings(page);
}

/** Turns clipboard-trim-trailing-spaces off (on by default), so a copy keeps every trailing space, and returns. */
export async function disableCopyTrim(page: Page): Promise<void> {
  await openTerminalSettings(page);
  const toggle = page.getByRole("switch", { name: "clipboard-trim-trailing-spaces", exact: true });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await closeSettings(page);
}
