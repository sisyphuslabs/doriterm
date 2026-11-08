// Mobile nav phase 4: the phone's switch sheet opens on the session's own space (Needs you and All spaces a segment
// away), with a new tab in that space at its foot. It is a history entry of its own (`&sheet=switch`): Back closes the
// sheet and leaves the session as it was, and a pick takes the sheet's place and the session's, so Back still goes to
// where the session was opened from.
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
  readonly plan: string;
  readonly review: string;
}

/** website (deploy needs you, tests done) and infra (plan working, review needs you), every tab unnamed. */
function seed(): Seeded {
  const root = mkdtempSync(join(tmpdir(), "phone-switch-"));
  const seeded = {
    deploy: startAgent("host", "deploy", "blocked", "website"),
    tests: startAgent("host", "tests", "done", "website"),
    plan: startAgent("host", "plan", "working", "infra"),
    review: startAgent("host", "review", "blocked", "infra"),
  };
  seedSpaces([
    {
      id: "spc-web",
      name: "website",
      folder: mkdtempSync(join(root, "website-")),
      tabs: [
        { id: "tb-deploy", name: "", terminal: seeded.deploy },
        { id: "tb-tests", name: "", terminal: seeded.tests },
      ],
    },
    {
      id: "spc-infra",
      name: "infra",
      folder: mkdtempSync(join(root, "infra-")),
      tabs: [
        { id: "tb-plan", name: "", terminal: seeded.plan },
        { id: "tb-review", name: "", terminal: seeded.review },
      ],
    },
  ]);
  return seeded;
}

const end = (seeded: Seeded): void => Object.values(seeded).forEach((address) => endAgent("host", address));
const param = (page: Page, name: string): string | null => new URL(page.url()).searchParams.get(name);
const header = (page: Page) => page.getByRole("banner");
const title = (page: Page) => header(page).getByRole("heading", { level: 1 });
const switcher = (page: Page) => page.locator("[data-phone-tabs]").getByRole("button", { name: /^Switch tab, / });
const sheetOf = (page: Page) => page.getByRole("dialog", { name: "Switch" });
const segment = (page: Page, name: RegExp) =>
  sheetOf(page).getByRole("group", { name: "Show" }).getByRole("button", { name });
const rowsIn = (page: Page, region: string) => sheetOf(page).getByRole("region", { name: region }).getByRole("button");
const named = (page: Page, region: string, name: string) =>
  rowsIn(page, region).filter({ has: page.locator(`[data-floor="name"]`, { hasText: new RegExp(`^${name}$`) }) });

/** website's screen from the Spaces tab, then its deploy session: three entries over the agents list. */
async function openDeploy(page: Page, seeded: Seeded): Promise<string> {
  await page.goto("/?v=spaces");
  await page
    .getByRole("button", { name: /^website\b/ })
    .first()
    .click();
  await page.getByRole("region", { name: "Tabs" }).getByRole("button").filter({ hasText: "deploy" }).click();
  await expect(page.locator(`[data-terminal="${seeded.deploy}"]`)).toBeVisible({ timeout: 20_000 });
  await expect(title(page)).toHaveAccessibleName("deploy");
  return page.url();
}

async function openSheet(page: Page): Promise<void> {
  await switcher(page).click();
  await opened(sheetOf(page));
  await expect.poll(() => param(page, "sheet")).toBe("switch");
}

const PHONES = { "iPhone 14": devices["iPhone 14"], "Pixel 7": devices["Pixel 7"] };

for (const [phoneName, device] of Object.entries(PHONES)) {
  test.describe(`${phoneName} at 390x844`, () => {
    const { defaultBrowserType: _engine, ...metrics } = device;
    test.use({ ...metrics, viewport: { width: 390, height: 844 }, serviceWorkers: "block" });

    test("the sheet opens on the session's space alone, and Back closes only the sheet", async ({ page }) => {
      const seeded = seed();
      try {
        const session = await openDeploy(page, seeded);
        await openSheet(page);
        await expect(segment(page, /^website$/)).toHaveAttribute("aria-pressed", "true");
        await expect(rowsIn(page, "website")).toHaveCount(2);
        await expect(named(page, "website", "deploy")).toHaveAttribute("aria-current", "true");
        await expect(named(page, "website", "tests")).toHaveCount(1);
        await expect(sheetOf(page).getByRole("region", { name: "infra" }), "no other space by default").toHaveCount(0);
        await expect(sheetOf(page).getByRole("button", { name: "New tab in website" })).toBeVisible();

        await page.goBack();
        await expect(sheetOf(page)).toBeHidden();
        expect(page.url()).toBe(session);
        await expect(page.locator(`[data-terminal="${seeded.deploy}"]`)).toBeVisible();
        await expect(title(page)).toHaveAccessibleName("deploy");
        // The sheet's entry is gone and nothing else was added: one more Back is the space the session came from.
        await page.goBack();
        await expect(page.getByRole("heading", { level: 1, name: "website" })).toBeVisible();
      } finally {
        end(seeded);
      }
    });

    test("Needs you and All spaces list the other spaces; a pick takes the sheet's and the session's place", async ({
      page,
    }) => {
      const seeded = seed();
      try {
        await openDeploy(page, seeded);
        await openSheet(page);
        await segment(page, /^Needs you/).click();
        await expect(segment(page, /^Needs you/)).toContainText("2");
        await expect(named(page, "website", "deploy")).toHaveCount(1);
        await expect(named(page, "infra", "review")).toHaveCount(1);
        await expect(sheetOf(page).locator('[data-floor="name"]')).toHaveCount(2);

        await segment(page, /^All spaces$/).click();
        await expect(rowsIn(page, "website")).toHaveCount(2);
        await expect(rowsIn(page, "infra")).toHaveCount(2);
        await named(page, "infra", "review").click();
        await expect(sheetOf(page)).toBeHidden();
        await expect(page.locator(`[data-terminal="${seeded.review}"]`)).toBeVisible({ timeout: 20_000 });
        await expect(title(page)).toHaveAccessibleName("review");
        await expect.poll(() => param(page, "sheet")).toBeNull();

        // Neither the sheet nor deploy is left under review: Back is the space deploy was opened from.
        await page.goBack();
        await expect(page.getByRole("heading", { level: 1, name: "website" })).toBeVisible();
      } finally {
        end(seeded);
      }
    });

    test("New tab in the space starts a tab there in place of the sheet", async ({ page }) => {
      const seeded = seed();
      let made: string | null = null;
      try {
        await openDeploy(page, seeded);
        await openSheet(page);
        await sheetOf(page).getByRole("button", { name: "New tab in website" }).click();
        await expect(sheetOf(page)).toBeHidden();
        // A new tab lands beside the one in view, so it is the second of three.
        await expect(switcher(page)).toHaveAccessibleName(/, tab 2 of 3$/, { timeout: 20_000 });
        made = await page.locator("[data-terminal]").first().getAttribute("data-terminal");
        expect(Object.values(seeded)).not.toContain(made);
        await expect.poll(() => param(page, "sheet")).toBeNull();

        await page.goBack();
        await expect(page.getByRole("heading", { level: 1, name: "website" })).toBeVisible();
        await expect(page.getByRole("region", { name: "Tabs" }).getByRole("button")).toHaveCount(3);
      } finally {
        if (made !== null) endAgent("host", made);
        end(seeded);
      }
    });

    test("a cold open of the sheet's address shows it; Done closes it to the session, never out of the app", async ({
      page,
    }) => {
      const seeded = seed();
      try {
        const session = new URL(await openDeploy(page, seeded));
        const cold = await page.context().newPage();
        await cold.goto(`${session.pathname}${session.search}&sheet=switch`);
        await opened(sheetOf(cold));
        await expect(rowsIn(cold, "website")).toHaveCount(2);
        await sheetOf(cold).getByRole("button", { name: "Done", exact: true }).click();
        await expect(sheetOf(cold)).toBeHidden();
        await expect.poll(() => param(cold, "sheet")).toBeNull();
        await expect(cold.locator(`[data-terminal="${seeded.deploy}"]`)).toBeVisible();
        await expect(title(cold)).toHaveAccessibleName("deploy");
      } finally {
        end(seeded);
      }
    });
  });
}
