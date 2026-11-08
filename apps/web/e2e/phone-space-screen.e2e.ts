// #1387: on a phone a space row opens that space's own screen (its tabs, New tab in it), one history entry over the
// list, so Back walks back down: terminal -> space -> Agents. A desktop's space row still only selects the space.
import { devices, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endAgent, startAgent } from "./agents.ts";
import { getCoreDoc } from "./core-doc.ts";
import { expect, test } from "./fixtures.ts";
import { LAYOUT_DOC, seedSpaces } from "./layout-doc.ts";

interface Seeded {
  readonly deploy: string;
  readonly tests: string;
  readonly plan: string;
}

/** website (deploy, tests) and infra (plan), each tab unnamed, so the rows read their terminals' names. */
function seed(): Seeded {
  const root = mkdtempSync(join(tmpdir(), "phone-space-"));
  const seeded = {
    deploy: startAgent("host", "deploy", "blocked", "website"),
    tests: startAgent("host", "tests", "done", "website"),
    plan: startAgent("host", "plan", "working", "infra"),
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
      tabs: [{ id: "tb-plan", name: "", terminal: seeded.plan }],
    },
  ]);
  return seeded;
}

const end = (seeded: Seeded): void => Object.values(seeded).forEach((address) => endAgent("host", address));
const param = (page: Page, name: string): string | null => new URL(page.url()).searchParams.get(name);
const spaceRow = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name}\\b`) }).first();
const tabRows = (page: Page) => page.getByRole("region", { name: "Tabs" }).getByRole("button");
const agentsHeading = (page: Page) => page.getByRole("heading", { name: "Agents", exact: true });

/** How many tabs the saved layout gives the space named `name`. */
function savedTabs(name: string): number {
  const doc = getCoreDoc(LAYOUT_DOC) as { spaces?: { name?: string; tabs?: unknown[] }[] } | null;
  return (doc?.spaces ?? []).find((each) => each.name === name)?.tabs?.length ?? 0;
}

async function openWebsite(page: Page): Promise<void> {
  await page.goto("/");
  await expect(spaceRow(page, "website")).toBeVisible({ timeout: 20_000 });
  await spaceRow(page, "website").click();
  await expect(page.getByRole("heading", { level: 1, name: "website" })).toBeVisible({ timeout: 10_000 });
}

const PHONES = { "iPhone 14": devices["iPhone 14"], "Pixel 7": devices["Pixel 7"] };

for (const [phoneName, device] of Object.entries(PHONES)) {
  test.describe(`${phoneName} at 390x844`, () => {
    const { defaultBrowserType: _engine, ...metrics } = device;
    test.use({ ...metrics, viewport: { width: 390, height: 844 }, serviceWorkers: "block" });

    test("a space row opens the space's screen of tabs, and Back walks down terminal, space, Agents", async ({
      page,
    }) => {
      const seeded = seed();
      try {
        await openWebsite(page);
        expect(param(page, "s"), "the space is in the address").not.toBeNull();
        expect(param(page, "t")).toBeNull();
        await expect(tabRows(page)).toHaveCount(2);
        await expect(tabRows(page).nth(0)).toContainText("deploy");
        await expect(tabRows(page).nth(1)).toContainText("tests");
        await expect(page.getByText("2 tabs · 1 needs you")).toBeVisible();
        const space = param(page, "s");

        await tabRows(page).filter({ hasText: "tests" }).click();
        await expect(page.locator(`[data-terminal="${seeded.tests}"]`)).toBeVisible({ timeout: 20_000 });
        expect(param(page, "t")).not.toBeNull();
        expect(param(page, "s"), "the terminal remembers the space it came from").toBe(space);

        await page.goBack();
        await expect(page.getByRole("heading", { level: 1, name: "website" })).toBeVisible();
        await expect(tabRows(page)).toHaveCount(2);
        expect(param(page, "t")).toBeNull();

        await page.goBack();
        await expect(agentsHeading(page)).toBeVisible();
        await expect.poll(() => param(page, "s")).toBeNull();
      } finally {
        end(seeded);
      }
    });

    test("the space screen's Back returns to Agents, also on a cold open of the space's address", async ({ page }) => {
      const seeded = seed();
      try {
        await page.goto("/");
        await expect(spaceRow(page, "infra")).toBeVisible({ timeout: 20_000 });
        const entries = await page.evaluate(() => history.length);
        await spaceRow(page, "infra").click();
        await expect(page.getByRole("heading", { level: 1, name: "infra" })).toBeVisible({ timeout: 10_000 });
        expect(await page.evaluate(() => history.length), "opening a space adds one entry").toBe(entries + 1);
        await expect(tabRows(page)).toHaveCount(1);
        const url = page.url();

        await page.getByRole("button", { name: "Back to agents" }).click();
        await expect(agentsHeading(page)).toBeVisible();
        await expect.poll(() => param(page, "s")).toBeNull();

        // Straight onto the space's own address, with nothing of this page's behind it: Back must not leave the app.
        await page.goto(url);
        await expect(page.getByRole("heading", { level: 1, name: "infra" })).toBeVisible({ timeout: 20_000 });
        await page.getByRole("button", { name: "Back to agents" }).click();
        await expect(agentsHeading(page)).toBeVisible();
        await expect.poll(() => param(page, "s")).toBeNull();
      } finally {
        end(seeded);
      }
    });

    test("New tab in a space starts a tab in that space and opens it over the space's screen", async ({ page }) => {
      const seeded = seed();
      let made: string | null = null;
      try {
        await openWebsite(page);
        await page.getByRole("button", { name: "New tab in website" }).click();
        const opened = page.locator("[data-terminal]");
        await expect(opened).toHaveCount(1, { timeout: 20_000 });
        made = await opened.getAttribute("data-terminal");
        expect(Object.values(seeded)).not.toContain(made);
        expect(param(page, "t")).not.toBeNull();
        await expect.poll(() => savedTabs("website"), { timeout: 15_000 }).toBe(3);

        await page.goBack();
        await expect(page.getByRole("heading", { level: 1, name: "website" })).toBeVisible();
        await expect(tabRows(page)).toHaveCount(3);
      } finally {
        if (made !== null) endAgent("host", made);
        end(seeded);
      }
    });
  });
}

test("on a desktop a space row still only selects the space: no address, no history entry", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const seeded = seed();
  try {
    await page.goto("/");
    const row = page
      .getByRole("complementary", { name: "Workspace" })
      .getByRole("region", { name: "Spaces" })
      .getByRole("button", { name: /^website\b/ });
    await expect(row).toBeVisible({ timeout: 20_000 });
    const entries = await page.evaluate(() => history.length);
    await row.click();
    await expect(page.getByRole("tablist", { name: "Tabs" }).getByRole("tab")).toHaveCount(2);
    await expect(row).toHaveAttribute("aria-current", "true");
    expect(param(page, "s")).toBeNull();
    expect(await page.evaluate(() => history.length)).toBe(entries);
  } finally {
    end(seeded);
  }
});
