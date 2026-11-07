import type { Page } from "@playwright/test";
import { expect } from "./fixtures.ts";

/**
 * Raises the Agents pane the way a person drags its divider, one arrow press at a time, until the list scrolls no more:
 * the default share cut the third Idle row under the Settings footer in the README and social-card captures (#954).
 */
export async function fitAgents(page: Page): Promise<void> {
  const list = page.locator('[data-slot="agents-list"]');
  const hidden = () => list.evaluate((viewport) => viewport.scrollHeight - viewport.clientHeight);
  const divider = page.getByRole("separator", { name: "Resize Spaces and Agents" });
  await divider.focus();
  // oxlint-disable-next-line no-await-in-loop -- each press moves the divider on from where the last one left it
  for (let press = 0; press < 40 && (await hidden()) > 0; press++) await divider.press("ArrowUp");
  await divider.blur();
  expect(await hidden(), "every agent row shows in the capture").toBeLessThanOrEqual(0);
}
