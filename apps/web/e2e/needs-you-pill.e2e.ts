// Top-bar needs-you pill: counts live blocked terminals other than the focused one, opens the next on click,
// and disappears once no other terminal is blocked.
import type { Page } from "@playwright/test";
import { agentRow, endAgent, startAgent, startShell } from "./agents.ts";
import { expect, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

const focusedTerminal = (page: Page) => page.locator('[data-focused="true"] [data-terminal]');

// The spec seeds its own shell and a blocked agent, so it never depends on what other specs leave running.
const TAG = "nyp-" + Date.now().toString(36);
let seeded: string[] = [];
test.afterEach(() => {
  for (const address of seeded) endAgent("host", address);
  seeded = [];
});

test("top-bar needs-you pill opens the blocked agent and updates its remaining count", async ({ page }) => {
  const shell = startShell("host", TAG + "-shell");
  seeded = [shell, startAgent("host", TAG + "-wait", "blocked")];
  await page.goto("/");
  await agentRow(page, TAG + "-shell", false).click({ timeout: 20_000 });
  await expect(focusedTerminal(page)).toContainText("$", { timeout: 15_000 });

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
  // The pill opens a blocked agent: the focus leaves the shell.
  await expect(focusedTerminal(page)).not.toHaveAttribute("data-terminal", shell, { timeout: 15_000 });

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
