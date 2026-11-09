import { devices, type Page } from "@playwright/test";
import { agentRow } from "./agents.ts";
import { expect, laidOutBox, opened, test } from "./fixtures.ts";
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
  // Both new controls take a 44 px tap, as every phone target does (#1030).
  for (const control of [
    section.getByRole("button", { name: "Close t2", exact: true }),
    section.getByRole("button", { name: "New tab", exact: true }),
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- measured at rest, one after the other
    const box = await laidOutBox(control);
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
  }
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

test("closing the tab the phone is showing moves it to the tab in its place (#1478)", async ({ page }) => {
  const run = Date.now().toString(36);
  const space = `tso-${run}`;
  const first = `tso-a-${run}`;
  const started = [startShellIn(space, first), startShellIn(space, `tso-b-${run}`)];
  seedSpaces([
    {
      id: "spc-tso",
      name: space,
      folder: "",
      tabs: started.map((terminal, index) => ({ id: `tb-tso-${index}`, name: `t${index + 1}`, terminal })),
    },
  ]);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await agentRow(page, first, false).click();
  await expect(header(page).getByRole("heading", { name: "t1", exact: true })).toBeVisible({ timeout: 15_000 });

  await switcher(page).click();
  await opened(sheet(page));
  // The open tab's own row: closing it leaves the phone on a tab that no longer exists unless it is moved on (#1478).
  await sheet(page).getByRole("region", { name: space }).getByRole("button", { name: "Close t1", exact: true }).click();

  // t2 takes its place, as a pick of t2 would: the space's next tab, not the space screen and not a dead terminal.
  await expect(header(page).getByRole("heading", { name: "t2", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`[data-terminal="${started[0]}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-terminal="${started[1]}"]`)).toBeVisible();
  await expect(switcher(page)).toContainText("1/1");
});

test("closing the phone's only tab from the sheet leaves the screen for the list (#1478)", async ({ page }) => {
  const run = Date.now().toString(36);
  const space = `tsl-${run}`;
  const only = `tsl-a-${run}`;
  const started = startShellIn(space, only);
  seedSpaces([{ id: "spc-tsl", name: space, folder: "", tabs: [{ id: "tb-tsl-0", name: "t1", terminal: started }] }]);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await agentRow(page, only, false).click();
  await expect(header(page).getByRole("heading", { name: "t1", exact: true })).toBeVisible({ timeout: 15_000 });

  await switcher(page).click();
  await opened(sheet(page));
  // A space's last tab takes the space with it, so this close asks first.
  await sheet(page).getByRole("region", { name: space }).getByRole("button", { name: "Close t1", exact: true }).click();
  const question = page.getByRole("dialog", { name: "Close space?" });
  await expect(question).toBeVisible();
  await question.getByRole("button", { name: "Close", exact: true }).click();

  // Nothing is left to show in that space, so the phone goes up to the list it came from.
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-terminal]")).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get("t")).toBeNull();
});
