import type { Page } from "@playwright/test";
import { agentRow, endAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { hcOn } from "./machine-switch.ts";
import { expectTouchTargets, PHONE } from "./phone-key-bar.ts";

// An agent waiting on a person with nothing this client can draw a card for gets Enter, Esc and the arrows over its
// terminal, one tap each; the strip goes once the agent stops waiting (#1527).
test.use({ serviceWorkers: "block" });

/** Asks "Continue?" as a blocked agent, then prints the line it read (cat -v) as working. */
function startWaiting(name: string, app: string): string {
  const osc = (fields: string) => `printf '\\033]7501;${fields}\\033\\\\'`;
  const script = [
    osc(`state=blocked:kind=permission:app=${app}`),
    "printf 'Continue? [Y/n] '",
    "IFS= read -r line",
    osc(`state=working:app=${app}`),
    `printf 'got:%s\\n' "$line" | cat -v`,
    "exec sleep 600",
  ].join("; ");
  const started: unknown = JSON.parse(hcOn("host", ["run", "--bg", "--name", name, "--", "sh", "-c", script]));
  if (typeof started !== "object" || started === null || !("address" in started)) throw new Error("no address");
  return String(started.address);
}

const strip = (page: Page) => page.getByRole("group", { name: "Answer the waiting agent" });

test("desktop: Esc, an arrow and Enter reach the waiting agent, and the strip goes once it moves on", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const address = startWaiting("asker-desk", "demo-agent");
  try {
    await page.goto("/");
    await agentRow(page, "asker-desk", false).click({ timeout: 20_000 });
    await expect(strip(page)).toBeVisible({ timeout: 15_000 });
    await strip(page).getByRole("button", { name: "Escape" }).click();
    await strip(page).getByRole("button", { name: "Arrow up" }).click();
    await strip(page).getByRole("button", { name: "Enter" }).click();
    await expect(page.locator(`[data-terminal="${address}"]`)).toContainText("got:^[^[[A", { timeout: 10_000 });
    await expect(strip(page)).toHaveCount(0, { timeout: 10_000 });
  } finally {
    endAgent("host", address);
  }
});

test("an agent whose prompts get a card has no strip", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const address = startWaiting("asker-card", "claude-code");
  try {
    await page.goto("/");
    await agentRow(page, "asker-card", false).click({ timeout: 20_000 });
    await expect(page.locator(`[data-terminal="${address}"]`)).toContainText("Continue?", { timeout: 15_000 });
    await expect(strip(page)).toHaveCount(0);
  } finally {
    endAgent("host", address);
  }
});

test.describe("phone", () => {
  test.use(PHONE);

  test("one tap of Enter answers, with the keyboard down and 44 pt keys", async ({ page }) => {
    const address = startWaiting("asker-phone", "demo-agent");
    try {
      await page.goto("/");
      await agentRow(page, "asker-phone", false).click({ timeout: 20_000 });
      await expect(strip(page)).toBeVisible({ timeout: 15_000 });
      await expectTouchTargets(strip(page));
      await strip(page).getByRole("button", { name: "Enter" }).tap();
      await expect(page.locator(`[data-terminal="${address}"]`)).toContainText("got:", { timeout: 10_000 });
      await expect(page.locator("[data-terminal] textarea")).not.toBeFocused();
      await expect(strip(page)).toHaveCount(0, { timeout: 10_000 });
    } finally {
      endAgent("host", address);
    }
  });
});
