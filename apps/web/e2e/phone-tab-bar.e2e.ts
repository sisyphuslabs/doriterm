// The phone's bottom tab bar: Agents (with how many need you), Spaces and Settings, on the lists only. Spaces is its own
// list at `?v=spaces`, one entry over the agents, so Back from it is the agents again; the agents list holds no spaces.
import { devices, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";

interface Seeded {
  readonly deploy: string;
  readonly review: string;
  readonly tests: string;
  readonly plan: string;
}

/** website (deploy, tests) and infra (plan, review): two agents need you, one is done, one works. */
function seed(): Seeded {
  const root = mkdtempSync(join(tmpdir(), "phone-tab-bar-"));
  const seeded = {
    deploy: startAgent("host", "deploy", "blocked", "website"),
    review: startAgent("host", "review", "blocked", "infra"),
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
const bar = (page: Page) => page.getByRole("navigation", { name: "Sections" });
const agentsTab = (page: Page) => bar(page).getByRole("button", { name: /^Agents\b/ });
const spacesTab = (page: Page) => bar(page).getByRole("button", { name: "Spaces", exact: true });
const settingsTab = (page: Page) => bar(page).getByRole("link", { name: /^Settings\b/ });
const title = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
const spacesList = (page: Page) => page.getByRole("main").getByRole("region", { name: "Spaces" });
const spaceRow = (page: Page, name: string) =>
  spacesList(page).getByRole("button", { name: new RegExp(`^${name}\\b`) });

/** The Agents list, its rows drawn: the agents' groups are in, so the badge has its count. */
async function openAgents(page: Page): Promise<void> {
  await page.goto("/");
  await expect(title(page, "Agents")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: /\bdeploy\b/ }).first()).toBeVisible({ timeout: 20_000 });
}

const PHONES = { "iPhone 14": devices["iPhone 14"], "Pixel 7": devices["Pixel 7"] };

for (const [phoneName, device] of Object.entries(PHONES)) {
  test.describe(`${phoneName} at 390x844`, () => {
    const { defaultBrowserType: _engine, ...metrics } = device;
    test.use({ ...metrics, viewport: { width: 390, height: 844 }, serviceWorkers: "block" });

    test("the Agents list has the bar: three tabs, Agents current with the Needs-you count, each a full target", async ({
      page,
    }) => {
      const seeded = seed();
      try {
        await openAgents(page);
        await expect(bar(page)).toBeVisible();
        await expect(bar(page).locator("a, button")).toHaveCount(3);
        await expect(agentsTab(page)).toHaveAttribute("aria-current", "page");
        await expect(spacesTab(page)).not.toHaveAttribute("aria-current", /.*/);
        await expect(settingsTab(page)).not.toHaveAttribute("aria-current", /.*/);

        const needsYou = page
          .getByRole("region", { name: "Needs you" })
          .getByRole("button", { name: /^(?!More for).*\b(deploy|review)\b/ });
        await expect(needsYou).toHaveCount(2);
        await expect(agentsTab(page).locator("[data-slot='tab-badge']")).toHaveText("2");
        await expect(agentsTab(page)).toHaveAccessibleName("Agents, 2 need you");

        const box = await bar(page).boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(49);
        expect((box?.y ?? 0) + (box?.height ?? 0), "the bar sits on the screen's bottom edge").toBeCloseTo(844, 0);
        const sizes = await Promise.all(
          (await bar(page).locator("a, button").all()).map((target) => target.boundingBox()),
        );
        for (const size of sizes) {
          expect(size?.width ?? 0).toBeGreaterThanOrEqual(44);
          expect(size?.height ?? 0).toBeGreaterThanOrEqual(44);
        }
        await expect(page.getByRole("main").getByRole("region", { name: "Spaces" }), "no spaces on Agents").toHaveCount(
          0,
        );
      } finally {
        end(seeded);
      }
    });

    test("Spaces is its own list at ?v=spaces, grouped rows under it, and Back returns to Agents", async ({ page }) => {
      const seeded = seed();
      try {
        await openAgents(page);
        const entries = await page.evaluate(() => history.length);
        await spacesTab(page).click();
        await expect(title(page, "Spaces")).toBeVisible();
        expect(param(page, "v")).toBe("spaces");
        expect(await page.evaluate(() => history.length), "Spaces is one entry over the agents").toBe(entries + 1);
        await expect(spacesTab(page)).toHaveAttribute("aria-current", "page");
        await expect(agentsTab(page)).not.toHaveAttribute("aria-current", /.*/);
        await expect(spaceRow(page, "website")).toBeVisible({ timeout: 20_000 });
        await expect(spaceRow(page, "infra")).toBeVisible();
        await expect(page.getByRole("button", { name: /\bdeploy\b/ }), "no agent rows on Spaces").toHaveCount(0);

        await page.goBack();
        await expect(title(page, "Agents")).toBeVisible();
        await expect.poll(() => param(page, "v")).toBeNull();
        await expect(agentsTab(page)).toHaveAttribute("aria-current", "page");

        // The Agents tab from Spaces goes back down to the agents rather than stacking an entry.
        await spacesTab(page).click();
        await expect(title(page, "Spaces")).toBeVisible();
        await agentsTab(page).click();
        await expect(title(page, "Agents")).toBeVisible();
        await expect.poll(() => param(page, "v")).toBeNull();
        expect(await page.evaluate(() => history.length)).toBe(entries + 1);
      } finally {
        end(seeded);
      }
    });

    test("a space row opens its screen keeping v=spaces, with no bar there, and its Back returns to Spaces", async ({
      page,
    }) => {
      const seeded = seed();
      try {
        await openAgents(page);
        await spacesTab(page).click();
        await expect(spaceRow(page, "website")).toBeVisible({ timeout: 20_000 });
        await spaceRow(page, "website").click();
        await expect(title(page, "website")).toBeVisible({ timeout: 10_000 });
        expect(param(page, "v")).toBe("spaces");
        expect(param(page, "s")).not.toBeNull();
        await expect(bar(page)).toHaveCount(0);

        await page.getByRole("button", { name: "Back to spaces" }).click();
        await expect(title(page, "Spaces")).toBeVisible();
        await expect.poll(() => param(page, "s")).toBeNull();
        expect(param(page, "v")).toBe("spaces");
        await expect(bar(page)).toBeVisible();
      } finally {
        end(seeded);
      }
    });

    test("an open terminal shows no bar, and closing it brings the bar back", async ({ page }) => {
      const seeded = seed();
      try {
        await openAgents(page);
        await page
          .getByRole("button", { name: /\btests\b/ })
          .first()
          .click();
        await expect(page.locator(`[data-terminal="${seeded.tests}"]`)).toBeVisible({ timeout: 20_000 });
        await expect(bar(page)).toHaveCount(0);
        await page.getByRole("button", { name: "Back to agents" }).click();
        await expect(title(page, "Agents")).toBeVisible();
        await expect(bar(page)).toBeVisible();
      } finally {
        end(seeded);
      }
    });

    test("the Settings tab opens Settings", async ({ page }) => {
      const seeded = seed();
      try {
        await openAgents(page);
        await settingsTab(page).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings");
      } finally {
        end(seeded);
      }
    });
  });
}
