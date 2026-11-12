// Mobile nav phase 5: a cold start on `/` (the home screen's icon) picks up where the phone was - its section, its space
// screen, its session - while an address that names a place wins; and a space's Rename and Close live in its own screen's
// header, so the phone's space rows hold no menu.
import { devices, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";

interface Seeded {
  readonly deploy: string;
  readonly tests: string;
  readonly plan: string;
}

/** website (deploy, tests) and infra (plan), every tab unnamed. */
function seed(): Seeded {
  const root = mkdtempSync(join(tmpdir(), "phone-memory-"));
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
const heading = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const spaceRow = (page: Page, name: string) =>
  page.getByRole("main").getByRole("button", { name: new RegExp(`^${name}\\b`) });
const params = (page: Page): string[] => [...new URL(page.url()).searchParams.keys()].toSorted();

/** A page of its own on `/`, as the home screen's icon opens the app: nothing of this tab's history behind it. */
async function coldStart(page: Page): Promise<Page> {
  const cold = await page.context().newPage();
  await cold.goto("/");
  return cold;
}

const PHONES = { "iPhone 14": devices["iPhone 14"], "Pixel 7": devices["Pixel 7"] };

for (const [phoneName, device] of Object.entries(PHONES)) {
  test.describe(`${phoneName} at 390x844`, () => {
    const { defaultBrowserType: _engine, ...metrics } = device;
    test.use({ ...metrics, viewport: { width: 390, height: 844 }, serviceWorkers: "block" });

    test("a cold start on / reopens the last session, and its Back walks up through its space to Spaces", async ({
      page,
    }) => {
      const seeded = seed();
      try {
        await page.goto("/?v=spaces");
        await spaceRow(page, "website").first().click();
        await page.getByRole("region", { name: "Tabs" }).getByRole("button").filter({ hasText: "deploy" }).click();
        await expect(page.locator(`[data-terminal="${seeded.deploy}"]`)).toBeVisible({ timeout: 20_000 });
        const left = new URL(page.url());

        const cold = await coldStart(page);
        await expect(cold.locator(`[data-terminal="${seeded.deploy}"]`)).toBeVisible({ timeout: 20_000 });
        expect(new URL(cold.url()).search).toBe(left.search);
        await cold.getByRole("banner").getByRole("button", { name: "Back to website" }).click();
        await expect(heading(cold, "website")).toBeVisible();
        await cold.getByRole("button", { name: "Back to spaces" }).click();
        await expect(heading(cold, "Spaces")).toBeVisible();
      } finally {
        end(seeded);
      }
    });

    test("the list reached last is the one a cold start shows, and the bare agents list restores nothing", async ({
      page,
    }) => {
      const seeded = seed();
      try {
        await page.goto("/?v=spaces");
        await expect(spaceRow(page, "website").first()).toBeVisible({ timeout: 20_000 });
        const spaces = await coldStart(page);
        await expect(heading(spaces, "Spaces")).toBeVisible({ timeout: 20_000 });
        expect(params(spaces)).toEqual(["v"]);

        await spaces
          .getByRole("navigation", { name: "Sections" })
          .getByRole("button", { name: /^Agents\b/ })
          .click();
        await expect(heading(spaces, "Agents")).toBeVisible();
        const agents = await coldStart(spaces);
        await expect(heading(agents, "Agents")).toBeVisible({ timeout: 20_000 });
        await expect(agents.getByRole("button", { name: /\bdeploy\b/ }).first()).toBeVisible({ timeout: 20_000 });
        expect(params(agents)).toEqual([]);
      } finally {
        end(seeded);
      }
    });

    test("an address that names a place wins over the remembered one", async ({ page }) => {
      const seeded = seed();
      try {
        await page.goto("/?v=spaces");
        await spaceRow(page, "infra").first().click();
        await expect(heading(page, "infra")).toBeVisible({ timeout: 20_000 });

        const named = await page.context().newPage();
        await named.goto("/?v=spaces");
        await expect(heading(named, "Spaces")).toBeVisible({ timeout: 20_000 });
        await expect(spaceRow(named, "website").first()).toBeVisible({ timeout: 20_000 });
        expect(params(named)).toEqual(["v"]);
      } finally {
        end(seeded);
      }
    });

    test("a space's Rename and Close are in its screen's header, and its row in Spaces holds no menu", async ({
      page,
    }) => {
      const seeded = seed();
      try {
        await page.goto("/?v=spaces");
        await expect(spaceRow(page, "website").first()).toBeVisible({ timeout: 20_000 });
        await expect(page.getByRole("main").getByRole("button", { name: /^More for / })).toHaveCount(0);

        await spaceRow(page, "website").first().click();
        await expect(heading(page, "website")).toBeVisible();
        const more = page.getByRole("banner").getByRole("button", { name: "More for website" });
        const box = await more.boundingBox();
        expect(Math.min(box?.width ?? 0, box?.height ?? 0)).toBeGreaterThanOrEqual(44);
        await more.click();
        await expect(page.getByRole("menuitem", { name: "Close space…" })).toBeVisible();
        await page.getByRole("menuitem", { name: "Rename space…" }).click();
        const dialog = page.getByRole("dialog", { name: "Rename website" });
        await dialog.getByRole("textbox", { name: "Name" }).fill("site");
        await dialog.getByRole("button", { name: "Rename" }).click();
        await expect(dialog).toBeHidden();
        await expect(heading(page, "site")).toBeVisible({ timeout: 15_000 });

        await page.getByRole("banner").getByRole("button", { name: "More for site" }).click();
        await page.getByRole("menuitem", { name: "Close space…" }).click();
        const asking = page.getByRole("dialog", { name: "Close space?" });
        await expect(asking).toContainText("site");
        await asking.getByRole("button", { name: "Cancel" }).click();
        await expect(heading(page, "site")).toBeVisible();
      } finally {
        end(seeded);
      }
    });
  });
}
