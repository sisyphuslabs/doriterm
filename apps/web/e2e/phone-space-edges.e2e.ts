// #1421: the phone's space screen at its edges - shown again under a terminal that went away (no slide, and Back pops to
// the list the page pushed it from), New tab in a space with no tabs, and a session's Back before its space is known.
import { devices, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endAgent, startAgent } from "./agents.ts";
import { getCoreDoc } from "./core-doc.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { expect, test } from "./fixtures.ts";
import { LAYOUT_DOC, seedSpaces } from "./layout-doc.ts";

const param = (page: Page, name: string): string | null => new URL(page.url()).searchParams.get(name);
const spaceRow = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name}\\b`) }).first();
const tabRows = (page: Page) => page.getByRole("region", { name: "Tabs" }).getByRole("button");
const heading = (page: Page, name: string) => page.getByRole("heading", { level: 1, name, exact: true });
/** The router's place of the entry in view in this tab's history (@tanstack/history). */
const entry = (page: Page): Promise<unknown> => page.evaluate(() => Reflect.get(history.state ?? {}, "__TSR_index"));

/** How many tabs the saved layout gives the space named `name`. */
function savedTabs(name: string): number {
  const doc = getCoreDoc(LAYOUT_DOC) as { spaces?: { name?: string; tabs?: unknown[] }[] } | null;
  return (doc?.spaces ?? []).find((each) => each.name === name)?.tabs?.length ?? 0;
}

/** website with two tabs (deploy, tests), each unnamed. */
function seedWebsite(): { readonly deploy: string; readonly tests: string } {
  const seeded = {
    deploy: startAgent("host", "deploy", "blocked", "website"),
    tests: startAgent("host", "tests", "done", "website"),
  };
  seedSpaces([
    {
      id: "spc-web",
      name: "website",
      folder: mkdtempSync(join(tmpdir(), "phone-edges-")),
      tabs: [
        { id: "tb-deploy", name: "", terminal: seeded.deploy },
        { id: "tb-tests", name: "", terminal: seeded.tests },
      ],
    },
  ]);
  return seeded;
}

const PHONES = { "iPhone 14": devices["iPhone 14"], "Pixel 7": devices["Pixel 7"] };

for (const [phoneName, device] of Object.entries(PHONES)) {
  test.describe(`${phoneName} at 390x844`, () => {
    const { defaultBrowserType: _engine, ...metrics } = device;
    test.use({ ...metrics, viewport: { width: 390, height: 844 }, serviceWorkers: "block" });

    test("a space screen shown again under a terminal that went away does not slide, and Back pops to Spaces", async ({
      page,
    }) => {
      const seeded = seedWebsite();
      const left = [seeded.deploy];
      try {
        const link = await routeHcSocket(page);
        await page.goto("/?v=spaces");
        await expect(spaceRow(page, "website")).toBeVisible({ timeout: 20_000 });
        await expect.poll(() => page.evaluate(() => document.documentElement.hasAttribute("data-ready"))).toBe(true);
        const list = await entry(page);
        await spaceRow(page, "website").click();
        await expect(heading(page, "website")).toBeVisible({ timeout: 10_000 });
        await tabRows(page).filter({ hasText: "tests" }).click();
        await expect(page.locator(`[data-terminal="${seeded.tests}"]`)).toBeVisible({ timeout: 20_000 });

        // The open terminal drops out of the list while its view never hears its program end (its end, on the stream and
        // on the feed, is held): the view's own Back on an end does not run, and its space's screen is shown again, with
        // no push, so it does not slide.
        link.holdFromHost("finished_ms");
        endAgent("host", seeded.tests);
        await expect(heading(page, "website")).toBeVisible({ timeout: 15_000 });
        await expect(page.locator(".motion-arrive").filter({ has: heading(page, "website") })).toHaveAttribute(
          "data-arrived",
          "",
        );

        // Its Back pops down to the Spaces entry the page pushed it from: no `?s=` entry is left under the list.
        await page.getByRole("button", { name: "Back to spaces" }).click();
        await expect(heading(page, "Spaces")).toBeVisible();
        await expect.poll(() => param(page, "s")).toBeNull();
        await expect.poll(() => entry(page)).toBe(list);
      } finally {
        left.forEach((address) => endAgent("host", address));
      }
    });

    test("New tab in a space with no tabs puts the tab in that space", async ({ page }) => {
      const deploy = startAgent("host", "deploy", "blocked", "website");
      let made: string | null = null;
      try {
        // A space with no tabs only comes from a layout another tool wrote; the selected space is website.
        seedSpaces([
          {
            id: "spc-web",
            name: "website",
            folder: mkdtempSync(join(tmpdir(), "phone-edges-web-")),
            tabs: [{ id: "tb-deploy", name: "", terminal: deploy }],
          },
          { id: "spc-empty", name: "notes", folder: mkdtempSync(join(tmpdir(), "phone-edges-notes-")), tabs: [] },
        ]);
        await page.goto("/?v=spaces");
        await expect(spaceRow(page, "notes")).toBeVisible({ timeout: 20_000 });
        await spaceRow(page, "notes").click();
        await expect(heading(page, "notes")).toBeVisible({ timeout: 10_000 });
        await page.getByRole("button", { name: "New tab here" }).click();
        const opened = page.locator("[data-terminal]");
        await expect(opened).toHaveCount(1, { timeout: 20_000 });
        made = await opened.getAttribute("data-terminal");
        await expect.poll(() => savedTabs("notes"), { timeout: 15_000 }).toBe(1);
        expect(savedTabs("website")).toBe(1);
      } finally {
        if (made !== null) endAgent("host", made);
        endAgent("host", deploy);
      }
    });

    test("a cold open of a session in a space not read yet shows Back as the chevron alone, then the space's name", async ({
      page,
    }) => {
      const seeded = seedWebsite();
      try {
        await page.goto("/?v=spaces");
        await spaceRow(page, "website").click();
        await tabRows(page).filter({ hasText: "deploy" }).click();
        await expect(page.locator(`[data-terminal="${seeded.deploy}"]`)).toBeVisible({ timeout: 20_000 });
        const url = page.url();

        // A page of its own whose layout documents are held: the session shows before its space is known.
        const cold = await page.context().newPage();
        const link = await routeHcSocket(cold);
        const release = link.hold("doc.get");
        await cold.goto(url);
        await expect(cold.locator(`[data-terminal="${seeded.deploy}"]`)).toBeVisible({ timeout: 20_000 });
        const back = cold.getByRole("banner").getByRole("button", { name: /^Back\b/ });
        await expect(back).toHaveAccessibleName("Back");
        await expect(back).toHaveText("");
        release();
        await expect(back).toHaveAccessibleName("Back to website", { timeout: 15_000 });
        await expect(back).toHaveText("website");
      } finally {
        Object.values(seeded).forEach((address) => endAgent("host", address));
      }
    });
  });
}
