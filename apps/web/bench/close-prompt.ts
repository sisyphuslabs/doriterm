// The render bench's Close prompt metric (#986): #560's budget, a Close question on screen within 200 ms of the click
// while terminals write, measured on the bench's runner instead of in the required Web e2e, where a shared, loaded
// runner made it measure how much CPU the page got.
import type { Page } from "@playwright/test";
import { clickToDialog } from "../e2e/close-probe.ts";
import { expect } from "../e2e/fixtures.ts";

/** Clicks on the bench tab's Close per run; their median is the metric. */
export const CLOSE_CLICKS = 5;

/**
 * One click's time to the Close question (e2e/close-probe.ts, the probe flood-input.e2e.ts uses), then Cancel. A locator
 * click, as when the 200 ms cap in thresholds.json was set.
 */
export async function closePrompt(page: Page): Promise<number> {
  const ms = await clickToDialog(page, { via: "locator" });
  if (ms === null) throw new Error("the Close click or its question was not seen by the page");
  const dialog = page.getByRole("dialog", { name: /^Close/ });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  return ms;
}
