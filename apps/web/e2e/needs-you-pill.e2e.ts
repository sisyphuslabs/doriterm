// Top-bar needs-you pill: counts live blocked terminals other than the focused one, opens the next on click,
// and disappears once no other terminal is blocked.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

const focusedTerminal = (page: Page) => page.locator('[data-focused="true"] [data-terminal]');

const openTerminal = async (page: Page, name: RegExp, text: string | RegExp): Promise<void> => {
  await page.getByRole("button", { name }).first().click();
  await expect(focusedTerminal(page)).toContainText(text, { timeout: 15_000 });
};

test("top-bar needs-you pill opens the blocked agent and updates its remaining count", async ({ page }) => {
  await page.goto("/");
  await openTerminal(page, /shell/, "$");

  const statusNeedsYou = page.getByRole("contentinfo").getByRole("button", { name: /needs you$/ });
  await expect(statusNeedsYou).toBeVisible({ timeout: 15_000 });
  const statusText = ((await statusNeedsYou.textContent()) ?? "").trim();
  const match = /^(\d+)\s+needs you$/.exec(statusText);
  expect(match).not.toBeNull();
  const totalBlocked = Number(match?.[1] ?? 0);
  expect(totalBlocked).toBeGreaterThanOrEqual(1);

  const pill = page
    .locator("[data-titlebar]")
    .getByRole("button", { name: `${totalBlocked} needs you, open the next`, exact: true });
  await expect(pill).toBeVisible();

  await pill.click();
  await expect(focusedTerminal(page)).toContainText("Waiting for approval", { timeout: 15_000 });

  const remaining = totalBlocked - 1;
  if (remaining === 0) {
    await expect(
      page.locator("[data-titlebar]").getByRole("button", { name: /needs you, open the next$/ }),
    ).toHaveCount(0);
  } else {
    await expect(
      page
        .locator("[data-titlebar]")
        .getByRole("button", { name: `${remaining} needs you, open the next`, exact: true }),
    ).toBeVisible();
  }
});
