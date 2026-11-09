// #1553: on a phone a terminal replaces the list it was opened from, so Back mounts that list anew. It has to come back
// where the reader left it (the same offset, the same first row), on the Agents list and on a space's screen of tabs,
// by the header's Back and by the system's Back alike.
import { devices, type Locator, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";

/** Enough rows that a 390x844 list scrolls well past one screen. */
const COUNT = 24;
const SPACE = "longspace";

/** COUNT agents, each its own tab of one space, so the Agents list and the space's Tabs screen are both long. */
function seed(): string[] {
  const root = mkdtempSync(join(tmpdir(), "phone-back-scroll-"));
  const names = Array.from({ length: COUNT }, (_, at) => `keep${String(at + 1).padStart(2, "0")}`);
  const addresses = names.map((name) => startAgent("host", name, "idle", SPACE));
  seedSpaces([
    {
      id: "spc-long",
      name: SPACE,
      folder: mkdtempSync(join(root, "long-")),
      tabs: addresses.map((terminal, at) => ({ id: `tb-long-${at}`, name: "", terminal })),
    },
  ]);
  return addresses;
}

interface Place {
  readonly top: number;
  /** The first row whose box reaches below the list's top edge. */
  readonly first: string;
}

/** Where the list is: its offset and the first agent row in view (headers and space rows are not counted). */
const place = (list: Locator): Promise<Place> =>
  list.evaluate((el) => {
    const edge = el.getBoundingClientRect().top;
    const first = [...el.querySelectorAll("button")].find(
      (row) => /keep\d\d/.test(row.textContent ?? "") && row.getBoundingClientRect().bottom > edge + 1,
    );
    return { top: el.scrollTop, first: first?.textContent ?? "" };
  });

/** Scrolls the list to half its overflow and waits for that offset to be the one it holds. */
async function scrollHalfway(list: Locator): Promise<Place> {
  const room = await list.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(room, "the list overflows the screen by more than a few rows").toBeGreaterThan(300);
  const target = Math.round(room / 2);
  await list.evaluate((el, top) => el.scrollTo({ top, behavior: "instant" }), target);
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(target);
  return place(list);
}

/** A row fully in view below the first one, so the tap is on what the reader sees. */
async function rowInView(list: Locator): Promise<Locator> {
  const index = await list.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const rows = [...el.querySelectorAll("button")].filter((row) => /^\s*keep\d\d/.test(row.textContent ?? ""));
    return rows.findIndex((row) => {
      const r = row.getBoundingClientRect();
      return r.top > box.top + 40 && r.bottom < box.bottom - 40;
    });
  });
  expect(index).toBeGreaterThanOrEqual(0);
  return list
    .locator("button")
    .filter({ hasText: /^\s*keep\d\d/ })
    .nth(index);
}

async function expectSamePlace(list: Locator, before: Place): Promise<void> {
  await expect.poll(() => list.evaluate((el) => el.scrollTop), "the same offset").toBe(before.top);
  expect((await place(list)).first, "the same first row in view").toBe(before.first);
}

const agentsList = (page: Page) => page.locator('[data-slot="agents-list"]');
const spaceTabs = (page: Page) => page.locator('[data-slot="space-tabs"]');
const agentsHeading = (page: Page) => page.getByRole("heading", { name: "Agents", exact: true });

const PHONES = { "iPhone 14": devices["iPhone 14"], "Pixel 7": devices["Pixel 7"] };

for (const [phoneName, device] of Object.entries(PHONES)) {
  test.describe(`${phoneName} at 390x844`, () => {
    const { defaultBrowserType: _engine, ...metrics } = device;
    test.use({ ...metrics, viewport: { width: 390, height: 844 }, serviceWorkers: "block" });

    test("Back from a terminal returns the Agents list to where it was, by the header and by history", async ({
      page,
    }) => {
      const addresses = seed();
      try {
        await page.goto("/");
        const list = agentsList(page);
        await expect(list.getByRole("button", { name: /keep24/ }).first()).toBeVisible({ timeout: 20_000 });

        // The header's Back.
        const before = await scrollHalfway(list);
        await (await rowInView(list)).click();
        await expect(page.getByRole("button", { name: /^Back to / })).toBeVisible({ timeout: 20_000 });
        await page.getByRole("button", { name: /^Back to / }).click();
        await expect(agentsHeading(page)).toBeVisible();
        await expectSamePlace(agentsList(page), before);

        // The system's Back, from another offset.
        await list.evaluate((el) => el.scrollTo({ top: el.scrollTop + 120, behavior: "instant" }));
        const again = await place(list);
        await (await rowInView(list)).click();
        await expect(page.getByRole("button", { name: /^Back to / })).toBeVisible({ timeout: 20_000 });
        await page.goBack();
        await expect(agentsHeading(page)).toBeVisible();
        await expectSamePlace(agentsList(page), again);
      } finally {
        addresses.forEach((address) => endAgent("host", address));
      }
    });

    test("Back from a terminal returns a space's Tabs screen to where it was, by the header and by history", async ({
      page,
    }) => {
      const addresses = seed();
      try {
        await page.goto("/");
        const spaceRow = page.getByRole("button", { name: new RegExp(`^${SPACE}\\b`) }).first();
        await expect(spaceRow).toBeVisible({ timeout: 20_000 });
        await spaceRow.click();
        const tabs = spaceTabs(page);
        await expect(tabs.getByRole("button", { name: /keep24/ }).first()).toBeVisible({ timeout: 20_000 });

        const before = await scrollHalfway(tabs);
        await (await rowInView(tabs)).click();
        await expect(page.getByRole("button", { name: `Back to ${SPACE}` })).toBeVisible({ timeout: 20_000 });
        await page.getByRole("button", { name: `Back to ${SPACE}` }).click();
        await expect(page.getByRole("heading", { level: 1, name: SPACE })).toBeVisible();
        await expectSamePlace(spaceTabs(page), before);

        await tabs.evaluate((el) => el.scrollTo({ top: el.scrollTop + 120, behavior: "instant" }));
        const again = await place(tabs);
        await (await rowInView(tabs)).click();
        await expect(page.getByRole("button", { name: `Back to ${SPACE}` })).toBeVisible({ timeout: 20_000 });
        await page.goBack();
        await expect(page.getByRole("heading", { level: 1, name: SPACE })).toBeVisible();
        await expectSamePlace(spaceTabs(page), again);
      } finally {
        addresses.forEach((address) => endAgent("host", address));
      }
    });
  });
}
