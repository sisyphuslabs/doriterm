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
  /** The name of the first row whose box reaches below the list's top edge. */
  readonly first: string;
  /** The rows `first` was picked from, so the place is read again the same way. */
  readonly row: RegExp;
}

/** An agent row: its name leads. A space row leads with its avatar's initial, so it is matched by name anywhere. */
const AGENT_ROW = /^\s*keep\d\d/;
const SPACE_ROW = /keep\d\d/;

/**
 * The list scrolls the document (#2533): its offset is the document scroller's, and what the reader sees of it is the band
 * between the pinned header and the pinned bars under it.
 */
const offset = (list: Locator): Promise<number> =>
  list.evaluate(() => Math.round((document.scrollingElement ?? document.documentElement).scrollTop));

/** Scrolls the document to `top` at once. */
const scrollDocument = (list: Locator, top: number): Promise<void> =>
  list.evaluate((_el, y) => window.scrollTo({ top: y, behavior: "instant" }), top);

/** Where the list is: its offset and the first seeded row in view, an agent's or a space's (headers are not counted). */
const place = async (list: Locator, row: RegExp = AGENT_ROW): Promise<Place> => {
  const at = await list.evaluate((el, source) => {
    const pattern = new RegExp(source);
    const edge = document.querySelector('[data-pinned="top"]')?.getBoundingClientRect().bottom ?? 0;
    const first = [...el.querySelectorAll("button")].find(
      (button) => pattern.test(button.textContent ?? "") && button.getBoundingClientRect().bottom > edge + 1,
    );
    // The row's name, not its whole text: the text ends with the agent's age, which moves on while the test runs.
    return {
      top: Math.round((document.scrollingElement ?? document.documentElement).scrollTop),
      first: /keep\d\d/.exec(first?.textContent ?? "")?.[0] ?? "",
    };
  }, row.source);
  return { ...at, row };
};

/** Scrolls the list to half its overflow and waits for that offset to be the one it holds. */
async function scrollHalfway(list: Locator, row: RegExp = AGENT_ROW): Promise<Place> {
  const room = await list.evaluate(() => {
    const scroller = document.scrollingElement ?? document.documentElement;
    return scroller.scrollHeight - scroller.clientHeight;
  });
  expect(room, "the list overflows the screen by more than a few rows").toBeGreaterThan(300);
  const target = Math.round(room / 2);
  await scrollDocument(list, target);
  await expect.poll(() => offset(list)).toBe(target);
  return place(list, row);
}

/** A row fully in view below the first one, so the tap is on what the reader sees. */
async function rowInView(list: Locator, row: RegExp = AGENT_ROW): Promise<Locator> {
  const index = await list.evaluate((el, source) => {
    const pattern = new RegExp(source);
    const top = document.querySelector('[data-pinned="top"]')?.getBoundingClientRect().bottom ?? 0;
    const bottom = document.querySelector('[data-pinned="bottom"]')?.getBoundingClientRect().top ?? window.innerHeight;
    const rows = [...el.querySelectorAll("button")].filter((button) => pattern.test(button.textContent ?? ""));
    return rows.findIndex((button) => {
      const r = button.getBoundingClientRect();
      return r.top > top + 40 && r.bottom < bottom - 40;
    });
  }, row.source);
  expect(index).toBeGreaterThanOrEqual(0);
  return list.locator("button").filter({ hasText: row }).nth(index);
}

/**
 * Waits out a pushed screen's arrival (it slides in, DESIGN.md 6). While it slides, its rows move: Playwright retries a
 * click on a moving row and scrolls it into view on each retry (block "end", then "center"), which takes the list off the
 * offset the test has just read, so Back rightly brings back the new one (#1968). Only the arriving screen's own transform
 * transition counts, as in phone-space-screen.e2e.ts: a button's colour or another region's fade is not the slide (#2059).
 */
const arrived = (screen: Locator): Promise<void> =>
  screen.evaluate(async (el) => {
    const sliding = (el.closest(".motion-arrive")?.getAnimations() ?? []).filter(
      (each) => each instanceof CSSTransition && each.transitionProperty === "transform",
    );
    await Promise.all(sliding.map((each) => each.finished.catch(() => undefined)));
  });

async function expectSamePlace(list: Locator, before: Place): Promise<void> {
  // A row pattern that matches nothing would pass below as '' === ''.
  expect(before.first, "a first row was found").not.toBe("");
  await expect.poll(() => offset(list), "the same offset").toBe(before.top);
  expect((await place(list, before.row)).first, "the same first row in view").toBe(before.first);
}

/** COUNT agents, each the one tab of its own space named like it, so the Agents list and the Spaces list are both long. */
function seedSpacesEach(): string[] {
  const root = mkdtempSync(join(tmpdir(), "phone-back-scroll-spaces-"));
  const names = Array.from({ length: COUNT }, (_, at) => `keep${String(at + 1).padStart(2, "0")}`);
  const addresses = names.map((name) => startAgent("host", name, "idle", name));
  seedSpaces(
    names.map((name, at) => ({
      id: `spc-${name}`,
      name,
      folder: mkdtempSync(join(root, `${name}-`)),
      tabs: [{ id: `tb-${name}`, name: "", terminal: addresses[at] ?? "" }],
    })),
  );
  return addresses;
}

const agentsList = (page: Page) => page.locator('[data-slot="agents-list"]');
const sections = (page: Page) => page.getByRole("navigation", { name: "Sections" });
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
        await scrollDocument(list, (await offset(list)) + 120);
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
        // The spaces are a list of their own, under the Spaces tab (#1484).
        await page.goto("/?v=spaces");
        const spaceRow = page.getByRole("button", { name: new RegExp(`^${SPACE}\\b`) }).first();
        await expect(spaceRow).toBeVisible({ timeout: 20_000 });
        await spaceRow.click();
        const tabs = spaceTabs(page);
        await expect(tabs.getByRole("button", { name: /keep24/ }).first()).toBeVisible({ timeout: 20_000 });
        await arrived(tabs);

        const before = await scrollHalfway(tabs);
        await (await rowInView(tabs)).click();
        await expect(page.getByRole("button", { name: `Back to ${SPACE}` })).toBeVisible({ timeout: 20_000 });
        await page.getByRole("button", { name: `Back to ${SPACE}` }).click();
        await expect(page.getByRole("heading", { level: 1, name: SPACE })).toBeVisible();
        await expectSamePlace(spaceTabs(page), before);

        await scrollDocument(tabs, (await offset(tabs)) + 120);
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

    test("Agents and Spaces share the list's frame but each keeps its own place, across the tabs and Back", async ({
      page,
    }) => {
      const addresses = seedSpacesEach();
      try {
        await page.goto("/");
        const list = agentsList(page);
        await expect(list.getByRole("button", { name: /keep24/ }).first()).toBeVisible({ timeout: 20_000 });
        const agents = await scrollHalfway(list);

        // The Spaces tab starts at its own top, not at the offset the agents were left at.
        await sections(page).getByRole("button", { name: "Spaces", exact: true }).click();
        await expect(page.getByRole("heading", { level: 1, name: "Spaces", exact: true })).toBeVisible();
        await expect(list.getByRole("button", { name: /^keep24\b/ })).toBeAttached();
        await expect.poll(() => offset(list), "Spaces opens at its top").toBe(0);

        // A space opened from Spaces, and Back: Spaces is where it was left, not where the agents were.
        const spaces = await scrollHalfway(list, SPACE_ROW);
        expect(spaces.top, "the two lists are left at different offsets").not.toBe(agents.top);
        await (await rowInView(list, SPACE_ROW)).click();
        await expect(page.getByRole("button", { name: "Back to Spaces" })).toBeVisible({ timeout: 20_000 });
        await page.getByRole("button", { name: "Back to Spaces" }).click();
        await expect(page.getByRole("heading", { level: 1, name: "Spaces", exact: true })).toBeVisible();
        await expectSamePlace(agentsList(page), spaces);

        // The Agents tab is the agents where they were left.
        await sections(page)
          .getByRole("button", { name: /^Agents\b/ })
          .click();
        await expect(agentsHeading(page)).toBeVisible();
        await expectSamePlace(agentsList(page), agents);
      } finally {
        addresses.forEach((address) => endAgent("host", address));
      }
    });
  });
}
