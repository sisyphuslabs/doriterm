import { devices, type Page } from "@playwright/test";
import { agentRow } from "./agents.ts";
import { expect, opened, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ ...phone, serviceWorkers: "block" });

// The test closes one tab and opens another: whatever is left of its terminals is ended after it.
endOwnTerminals();

const header = (page: Page) => page.getByRole("banner");
const switcher = (page: Page) => page.locator("[data-phone-tabs]").getByRole("button", { name: /^Switch tab, / });
const sheet = (page: Page) => page.getByRole("dialog", { name: "Spaces" });

function startShellIn(space: string, name: string): string {
  const out = hcOn("host", ["run", "--bg", "--name", name, "--label", `space=${space}`, "--", "env", "PS1=$ ", "sh"]);
  const started: unknown = JSON.parse(out);
  if (typeof started !== "object" || started === null || !("address" in started)) throw new Error(out);
  return String(started.address);
}

test("the Spaces sheet closes a tab as the strip's close does and starts a new tab in its space (#1463)", async ({
  page,
}) => {
  const run = Date.now().toString(36);
  const space = `tsh-${run}`;
  const first = `tsh-a-${run}`;
  const started = [startShellIn(space, first), startShellIn(space, `tsh-b-${run}`)];
  seedSpaces([
    {
      id: "spc-tsh",
      name: space,
      folder: "",
      tabs: started.map((terminal, index) => ({ id: `tb-tsh-${index}`, name: `t${index + 1}`, terminal })),
    },
  ]);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await agentRow(page, first, false).click();
  await expect(header(page).getByRole("heading", { name: "t1", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(switcher(page)).toContainText("1/2");

  await switcher(page).click();
  await opened(sheet(page));
  const section = sheet(page).getByRole("region", { name: space });
  // The same close as the desktop strip's: an idle shell asks nothing (confirm-close-surface), so the tab just goes.
  await section.getByRole("button", { name: "Close t2", exact: true }).click();
  // The sheet stays open, so several tabs can go in a row; the closed one leaves it.
  await expect(section.getByRole("button", { name: "Close t2", exact: true })).toHaveCount(0, { timeout: 15_000 });
  // A space's last tab takes the space with it, so its close asks first, over the sheet; Cancel keeps it.
  await section.getByRole("button", { name: "Close t1", exact: true }).click();
  const question = page.getByRole("dialog", { name: "Close space?" });
  await expect(question).toBeVisible();
  await question.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(question).toBeHidden();
  await expect(section.getByRole("button", { name: "Close t1", exact: true })).toBeVisible();
  await sheet(page).getByRole("button", { name: "Done", exact: true }).click();
  await expect(switcher(page)).toContainText("1/1");

  await switcher(page).click();
  await opened(sheet(page));
  await sheet(page).getByRole("region", { name: space }).getByRole("button", { name: "New tab", exact: true }).click();
  await expect(sheet(page)).toBeHidden();
  await expect(switcher(page)).toContainText("2/2", { timeout: 15_000 });
});
