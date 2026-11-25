import type { Page } from "@playwright/test";
import { startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { shortcut } from "./platform-keys.ts";
import { rows } from "./sidebar-measure.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

endOwnTerminals();

const SPACE = "order2746";

const working = (page: Page) =>
  page.getByRole("complementary", { name: "Workspace" }).getByRole("region", { name: "Working", exact: true });

const row = (page: Page, name: string) =>
  rows(working(page)).filter({ has: page.locator(`[data-floor="name"][title="${name}"]`) });

test("Next agent and Previous agent step through the rows as the Agents list draws them, a helper after its agent (#2746)", async ({
  page,
}) => {
  // The feed lists them as they started: lead, other, helper. The list draws the helper under the agent that started it.
  const lead = startAgent("host", "order-lead", "working", SPACE);
  startAgent("host", "order-other", "working", SPACE);
  startAgent("host", "order-helper", "working", SPACE, lead);
  await page.goto("/");
  await expect(rows(working(page)).filter({ hasText: /order-/ })).toHaveText(
    [/order-lead/, /order-helper/, /order-other/],
    { timeout: 20_000 },
  );

  await row(page, "order-lead").click();
  await expect(row(page, "order-lead")).toHaveAttribute("aria-current", "true");
  const terminal = page.locator(`[data-terminal="${lead}"]`).getByRole("textbox");
  await terminal.focus();
  await expect(terminal).toBeFocused();

  await page.keyboard.press(await shortcut(page, "agent.next"));
  await expect(row(page, "order-helper")).toHaveAttribute("aria-current", "true");
  await page.keyboard.press(await shortcut(page, "agent.next"));
  await expect(row(page, "order-other")).toHaveAttribute("aria-current", "true");
  await page.keyboard.press(await shortcut(page, "agent.prev"));
  await expect(row(page, "order-helper")).toHaveAttribute("aria-current", "true");
});
