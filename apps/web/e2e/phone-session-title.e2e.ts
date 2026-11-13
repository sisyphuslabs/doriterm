// Mobile nav phase 2: a phone session is named by its tab, else by its terminal - never by its place ("1", "2") - and its
// Back says where it goes: the space it was opened from, else the agents list.
import { devices, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endAgent, startAgent } from "./agents.ts";
import { expect, opened, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";

interface Seeded {
  readonly deploy: string;
  readonly tests: string;
}

/** website with two unnamed tabs, deploy and tests. */
function seed(): Seeded {
  const seeded = {
    deploy: startAgent("host", "deploy", "blocked", "website"),
    tests: startAgent("host", "tests", "done", "website"),
  };
  seedSpaces([
    {
      id: "spc-web",
      name: "website",
      folder: mkdtempSync(join(tmpdir(), "phone-title-")),
      tabs: [
        { id: "tb-deploy", name: "", terminal: seeded.deploy },
        { id: "tb-tests", name: "", terminal: seeded.tests },
      ],
    },
  ]);
  return seeded;
}

const end = (seeded: Seeded): void => Object.values(seeded).forEach((address) => endAgent("host", address));
const header = (page: Page) => page.getByRole("banner");
const title = (page: Page) => header(page).getByRole("heading", { level: 1 });
const switcher = (page: Page) => page.locator("[data-phone-tabs]").getByRole("button", { name: /^Switch tab, / });

const PHONES = { "iPhone 14": devices["iPhone 14"], "Pixel 7": devices["Pixel 7"] };

for (const [phoneName, device] of Object.entries(PHONES)) {
  test.describe(`${phoneName} at 390x844`, () => {
    const { defaultBrowserType: _engine, ...metrics } = device;
    test.use({ ...metrics, viewport: { width: 390, height: 844 }, serviceWorkers: "block" });

    test("a session opened from a space reads its agent's name, and Back says it returns to that space", async ({
      page,
    }) => {
      const seeded = seed();
      try {
        await page.goto("/?v=spaces");
        await page
          .getByRole("button", { name: /^website\b/ })
          .first()
          .click();
        await page.getByRole("region", { name: "Tabs" }).getByRole("button").filter({ hasText: "deploy" }).click();
        await expect(page.locator(`[data-terminal="${seeded.deploy}"]`)).toBeVisible({ timeout: 20_000 });

        await expect(title(page)).toHaveAccessibleName("deploy");
        await expect(title(page)).not.toHaveAccessibleName(/^\d+$/);
        await expect(header(page).locator("[data-agent-counts]")).toHaveCount(0);
        const back = header(page).getByRole("button", { name: "Back to website" });
        await expect(back).toBeVisible();
        await expect(back).toContainText("website");
        await expect(switcher(page)).toHaveAccessibleName("Switch tab, website, deploy, tab 1 of 2");
        await expect(switcher(page).getByText("deploy", { exact: true })).toBeVisible();
        await expect(switcher(page).getByText("1/2", { exact: true })).toBeVisible();
        // Beside the one round button (Read-only: the keys panel carries the keyboard's toggle, #2499) the bar has room for
        // the space too, and the tab's own name is still never cut.
        await expect(switcher(page).getByText("website ·", { exact: true })).toBeVisible();
        const name = switcher(page).getByText("deploy", { exact: true });
        await expect.poll(() => name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

        // The switch sheet names its rows the same way: no "1 \u00b7" before them.
        await switcher(page).click();
        const sheet = page.getByRole("dialog", { name: "Switch" });
        await opened(sheet);
        // Each tab's row, not its Close or the space's New tab (#1464).
        const rows = sheet
          .getByRole("region", { name: "website" })
          .getByRole("button", { name: /^(?!Close |New tab$)/ });
        await expect(rows).toHaveCount(2);
        await expect(rows.nth(0).locator('[data-floor="name"]')).toHaveText("deploy");
        await expect(rows.nth(1).locator('[data-floor="name"]')).toHaveText("tests");
        await rows.nth(1).click();
        await expect(title(page)).toHaveAccessibleName("tests", { timeout: 15_000 });

        // Under 360 px Back is the chevron alone, still a 44 px target that says where it goes.
        await page.setViewportSize({ width: 320, height: 700 });
        await expect(back.getByText("website")).toBeHidden();
        const box = await back.boundingBox();
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
        await page.setViewportSize({ width: 390, height: 844 });

        await back.click();
        await expect(page.getByRole("heading", { level: 1, name: "website" })).toBeVisible();
      } finally {
        end(seeded);
      }
    });

    test("a session opened from the agents list says Back to agents", async ({ page }) => {
      const seeded = seed();
      try {
        await page.goto("/");
        await page.getByRole("region", { name: "Agents" }).getByRole("button", { name: /tests/ }).first().click();
        await expect(page.locator(`[data-terminal="${seeded.tests}"]`)).toBeVisible({ timeout: 20_000 });
        await expect(title(page)).toHaveAccessibleName("tests");
        await header(page).getByRole("button", { name: "Back to agents" }).click();
        await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
      } finally {
        end(seeded);
      }
    });
    test("a cold open of a session's address says where Back goes, and goes there", async ({ page }) => {
      const seeded = seed();
      try {
        await page.goto("/?v=spaces");
        await page
          .getByRole("button", { name: /^website\b/ })
          .first()
          .click();
        await page.getByRole("region", { name: "Tabs" }).getByRole("button").filter({ hasText: "deploy" }).click();
        await expect(page.locator(`[data-terminal="${seeded.deploy}"]`)).toBeVisible({ timeout: 20_000 });
        const fromSpace = new URL(page.url());
        const fromSpaces = new URL(fromSpace);
        fromSpaces.searchParams.delete("s");
        const bare = new URL(fromSpaces);
        bare.searchParams.delete("v");

        // From a space: a page of its own on the session's address, with nothing of the app behind it.
        const cold = await page.context().newPage();
        await cold.goto(fromSpace.pathname + fromSpace.search);
        await expect(cold.locator(`[data-terminal="${seeded.deploy}"]`)).toBeVisible({ timeout: 20_000 });
        await header(cold).getByRole("button", { name: "Back to website" }).click();
        await expect(cold.getByRole("heading", { level: 1, name: "website" })).toBeVisible();

        // From the Spaces tab with no space: Back says Spaces and goes there.
        const coldSpaces = await page.context().newPage();
        await coldSpaces.goto(fromSpaces.pathname + fromSpaces.search);
        await expect(coldSpaces.locator(`[data-terminal="${seeded.deploy}"]`)).toBeVisible({ timeout: 20_000 });
        await header(coldSpaces).getByRole("button", { name: "Back to Spaces" }).click();
        await expect(coldSpaces.getByRole("heading", { level: 1, name: "Spaces", exact: true })).toBeVisible();

        // From no space: Back says the agents list and goes there.
        const coldBare = await page.context().newPage();
        await coldBare.goto(bare.pathname + bare.search);
        await expect(coldBare.locator(`[data-terminal="${seeded.deploy}"]`)).toBeVisible({ timeout: 20_000 });
        await header(coldBare).getByRole("button", { name: "Back to agents" }).click();
        await expect(coldBare.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
      } finally {
        end(seeded);
      }
    });
  });
}
