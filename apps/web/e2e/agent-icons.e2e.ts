import type { Locator, Page } from "@playwright/test";
import { startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { rows } from "./sidebar-measure.ts";
import { tabOf } from "./tab-strip.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

endOwnTerminals();

const SPACE = "icons2746";

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Workspace" });

const section = (page: Page, title: string) => sidebar(page).getByRole("region", { name: title, exact: true });

const rowNamed = (scope: Locator, name: string) =>
  rows(scope).filter({ has: scope.page().locator(`[data-floor="name"][title="${name}"]`) });

/** A program that reports `state` and `app` over OSC 7501 and then waits, started straight on the host core. */
function startAppAgent(name: string, state: string, app: string): string {
  const report = `printf '\\033]7501;state=${state}:app=${app}\\033\\\\'; sleep 600; :`;
  const out = hcOn("host", ["run", "--bg", "--name", name, "--label", `space=${SPACE}`, "--", "sh", "-c", report]);
  const started: unknown = JSON.parse(out);
  if (typeof started !== "object" || started === null || !("address" in started)) throw new Error(out);
  return String(started.address);
}

test("an agent reporting app=claude shows the Claude mark in its sidebar row and tab; a plain agent draws no mark (#2746, #2864)", async ({
  page,
}) => {
  const claude = startAppAgent("icon-claude", "working", "claude");
  startAgent("host", "icon-plain", "working", SPACE);
  await page.goto("/");

  const working = section(page, "Working");
  const claudeRow = rowNamed(working, "icon-claude");
  const plainRow = rowNamed(working, "icon-plain");
  await expect(claudeRow).toBeVisible({ timeout: 20_000 });
  await expect(plainRow).toBeVisible({ timeout: 20_000 });

  await expect(claudeRow.getByRole("img", { name: "Claude" })).toBeVisible();
  // Only a product has a mark: the generic agent glyph is not drawn (#2864, decision E2).
  await expect(plainRow.locator("[data-agent-mark]")).toHaveCount(0);
  await expect(plainRow.getByRole("img", { name: "Agent" })).toHaveCount(0);

  await claudeRow.click();
  const tab = await tabOf(page, claude);
  // The tab's title names the agent, so its mark is for the eye only: it is found by its key, not by a name.
  await expect(tab.locator('[data-agent-mark="claude"]')).toBeVisible();
  await expect(tab.getByRole("img", { name: "Claude" })).toHaveCount(0);
});
