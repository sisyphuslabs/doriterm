// iOS answers a tap on the status bar by scrolling the document's own scroller to the top, and nothing else (#2533). So a
// phone list screen scrolls the document: the list is not a box of its own that scrolls inside a fixed screen, and the
// header and the bars under the list stay put by sticking to the viewport's edges.
// Runs in Chromium by default; E2E_BROWSERS=all --project=webkit runs it in WebKit, the engine iOS uses.
import { devices, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endAgent, startAgent } from "./agents.ts";
import { expect, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";

const { defaultBrowserType: _engine, ...IPHONE } = devices["iPhone 14"];
test.use({ ...IPHONE, viewport: { width: 390, height: 844 }, serviceWorkers: "block" });

const COUNT = 24;
const SPACE = "docscroll";

/** COUNT agents, each a tab of one space, so the Agents list and the space's Tabs screen both run past one screen. */
function seed(): string[] {
  const root = mkdtempSync(join(tmpdir(), "phone-document-scroll-"));
  const addresses = Array.from({ length: COUNT }, (_, at) =>
    startAgent("host", `doc${String(at + 1).padStart(2, "0")}`, "idle", SPACE),
  );
  seedSpaces([
    {
      id: "spc-docscroll",
      name: SPACE,
      folder: mkdtempSync(join(root, "space-")),
      tabs: addresses.map((terminal, at) => ({ id: `tb-doc-${at}`, name: "", terminal })),
    },
  ]);
  return addresses;
}

interface Scrolling {
  /** How far the document can scroll. */
  readonly room: number;
  /** How far the list's own box can scroll: none, since the document does. */
  readonly listRoom: number;
}

const scrolling = (page: Page, slot: string): Promise<Scrolling> =>
  page.evaluate((selector) => {
    const scroller = document.scrollingElement ?? document.documentElement;
    const list = document.querySelector(selector);
    return {
      room: scroller.scrollHeight - scroller.clientHeight,
      listRoom: list === null ? -1 : list.scrollHeight - list.clientHeight,
    };
  }, `[data-slot="${slot}"]`);

/** The document scrolls to `top`, as a swipe or the status bar's tap does, and the offset it holds is read back. */
const scrollTo = async (page: Page, top: number): Promise<void> => {
  await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" }), top);
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(top);
};

/** The header's top edge against the viewport's, and whether the row named `first` shows under the pinned header. */
const view = (page: Page, first: RegExp) =>
  page.evaluate((source) => {
    const pinned = document.querySelector('[data-pinned="top"]');
    const edge = pinned?.getBoundingClientRect().bottom ?? 0;
    const pattern = new RegExp(source);
    const row = [...document.querySelectorAll("main button")].find((button) => pattern.test(button.textContent ?? ""));
    const box = row?.getBoundingClientRect();
    return {
      headerTop: Math.round(pinned?.getBoundingClientRect().top ?? -1),
      firstShows: box !== undefined && box.top >= edge - 1 && box.bottom <= window.innerHeight,
    };
  }, first.source);

async function expectDocumentScrolls(page: Page, slot: string, first: RegExp): Promise<void> {
  const { room, listRoom } = await scrolling(page, slot);
  expect(room, "the document scrolls the list").toBeGreaterThan(300);
  expect(listRoom, "the list's own box does not scroll").toBe(0);
  // The page does not bounce at its ends, so the pinned header and bars stay still there.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorY)).toBe("none");
  await scrollTo(page, room);
  expect((await view(page, first)).headerTop, "the header stays at the top while the list scrolls").toBe(0);
  expect((await view(page, first)).firstShows).toBe(false);
  // What iOS does for a tap on the status bar.
  await scrollTo(page, 0);
  expect((await view(page, first)).firstShows, "the first row is back in view").toBe(true);
}

test("at 390, the Agents list, the Spaces list and a space's tabs scroll the document, so the status bar's tap takes them to the top (#2533)", async ({
  page,
}) => {
  const addresses = seed();
  try {
    await page.goto("/");
    await expect(page.getByRole("button", { name: /doc24/ }).first()).toBeVisible({ timeout: 20_000 });
    await expectDocumentScrolls(page, "agents-list", /^\s*doc\d\d/);

    await page
      .getByRole("navigation", { name: "Sections" })
      .getByRole("button", { name: "Spaces", exact: true })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "Spaces", exact: true })).toBeVisible();
    const space = page.getByRole("button", { name: new RegExp(`^${SPACE}\\b`) }).first();
    await expect(space).toBeVisible({ timeout: 20_000 });
    await space.click();
    await expect(page.getByRole("heading", { level: 1, name: SPACE })).toBeVisible();
    await expect(page.locator('[data-slot="space-tabs"]').getByRole("button", { name: /doc24/ })).toBeAttached();
    await expectDocumentScrolls(page, "space-tabs", /doc\d\d/);
  } finally {
    addresses.forEach((address) => endAgent("host", address));
  }
});

test("at 390, Settings scrolls the document too, under its pinned title and tabs (#2533)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("link", { name: /^Settings/ })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  // The longest section, so the page runs well past one screen.
  await page.getByRole("tab", { name: "Keybindings", exact: true }).click();
  const { room, listRoom } = await scrolling(page, "settings-body");
  expect(room, "the document scrolls Settings").toBeGreaterThan(300);
  expect(listRoom, "the sections' body does not scroll by itself").toBe(0);
  const body = page.locator('[data-slot="settings-body"]');
  const bodyTopUnderPin = () =>
    body.evaluate((el) => {
      const pin = document.querySelector('[data-pinned="top"]')?.getBoundingClientRect();
      return {
        pinTop: Math.round(pin?.top ?? -1),
        bodyShows: el.getBoundingClientRect().top >= (pin?.bottom ?? 0) - 1,
      };
    });
  await scrollTo(page, room);
  expect(await bodyTopUnderPin()).toEqual({ pinTop: 0, bodyShows: false });
  await scrollTo(page, 0);
  expect(await bodyTopUnderPin()).toEqual({ pinTop: 0, bodyShows: true });
});

test("at 390, a list scrolled before Settings opens is where it was once Settings closes, by its button or by Back (#2533)", async ({
  page,
}) => {
  const addresses = seed();
  try {
    // Both closes are a history Back, which the browser would answer by putting the window's scroll back itself; with
    // that off, only the list's own keeping can bring the offset back.
    await page.addInitScript(() => {
      history.scrollRestoration = "manual";
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: /doc24/ }).first()).toBeVisible({ timeout: 20_000 });
    const { room } = await scrolling(page, "agents-list");
    const kept = Math.round(room / 2);
    await scrollTo(page, kept);
    // Settings opens over the list and closes by its own button, then by the browser's Back.
    const roundTrip = async (close: "button" | "back") => {
      await page
        .getByRole("navigation", { name: "Sections" })
        .getByRole("link", { name: /^Settings/ })
        .click();
      await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
      if (close === "button") await page.getByRole("button", { name: "Close settings" }).first().click();
      else await page.goBack();
      await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();
      await expect.poll(() => page.evaluate(() => Math.round(window.scrollY)), { message: close }).toBe(kept);
    };
    await roundTrip("button");
    await roundTrip("back");
  } finally {
    addresses.forEach((address) => endAgent("host", address));
  }
});
