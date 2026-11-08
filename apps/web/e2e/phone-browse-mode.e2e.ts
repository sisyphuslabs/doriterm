import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { reportedRows, reportRowOf, startMouseTracking, stopMouseTracking } from "./mouse-tracking.ts";
import { key, keysBar, openPhoneTerminal, PHONE } from "./phone-key-bar.ts";
import { pointOnRowStart, rowEnd } from "./terminal-points.ts";
import { Touch } from "./touch.ts";

test.use({ serviceWorkers: "block", ...PHONE, permissions: ["clipboard-read", "clipboard-write"] });

const browse = (page: Page) => key(page, "Read-only");
const painted = (page: Page) => page.locator(".term-selection-cells > div");
const input = (page: Page) => page.locator("[data-terminal] textarea");

/**
 * The view's scrollTop once it has stopped moving: a flick goes on scrolling after the finger lifts, so a gesture or a
 * point measured before it rests lands on rows that are still moving (#1491).
 */
const restingScrollTop = (viewport: Locator): Promise<number> =>
  viewport.evaluate(async (element) => {
    let last = element.scrollTop;
    for (let still = 0; still < 6;) {
      // oxlint-disable-next-line no-await-in-loop -- each frame is read after the one before it
      await new Promise((done) => requestAnimationFrame(done));
      still = element.scrollTop === last ? still + 1 : 0;
      last = element.scrollTop;
    }
    return last;
  });

/** The program hears a tap on `row` (the browser turns a tap into the mouse events the renderer reports). */
async function tapReaches(touch: Touch, terminal: Locator, row: string): Promise<void> {
  const before = (await reportedRows(terminal)).length;
  await touch.tap(await pointOnRowStart(terminal, row));
  await expect.poll(() => reportedRows(terminal).then((rows) => rows.length)).toBeGreaterThan(before);
}

/**
 * Nothing the program heard was on `row`. Read after a later gesture's report arrived: the program echoes what it
 * reads in order, so anything a gesture on `row` sent would already be on the screen.
 */
async function nothingReachedFrom(terminal: Locator, row: string): Promise<void> {
  const banned = await reportRowOf(terminal, row);
  expect(await reportedRows(terminal)).not.toContain(banned);
}

test("browsing read-only, a tap reaches neither the program nor the keyboard; leaving it, a tap does again", async ({
  page,
}) => {
  const terminal = await openPhoneTerminal(page);
  await startMouseTracking(page, terminal);
  const touch = await Touch.on(page);

  await input(page).blur();
  await tapReaches(touch, terminal, "alpha beta gamma");
  await expect(input(page)).toBeFocused();

  // The round buttons show once the keyboard is down.
  await input(page).blur();
  await browse(page).click();
  await expect(browse(page)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("status").filter({ hasText: "Read-only" })).toBeVisible();
  await expect(terminal).toHaveAttribute("data-browsing", "true");
  await expect(input(page)).not.toBeFocused();
  await expect(key(page, "Show keyboard")).toHaveCount(0);
  await expect(keysBar(page)).toHaveCount(0);

  await touch.tap(await pointOnRowStart(terminal, "delta epsilon zeta"));
  await expect(input(page)).not.toBeFocused();
  await expect(keysBar(page)).toHaveCount(0);

  await browse(page).click();
  await expect(browse(page)).toHaveAttribute("aria-pressed", "false");
  await expect(key(page, "Show keyboard")).toBeVisible();
  await expect(terminal).not.toHaveAttribute("data-browsing", "true");
  await tapReaches(touch, terminal, "alpha beta gamma");
  await expect(input(page)).toBeFocused();
  await nothingReachedFrom(terminal, "delta epsilon zeta");
  await stopMouseTracking(page);
});

test("browsing read-only, a held finger and a drag select, and the menu offers Copy without Paste", async ({
  page,
}) => {
  const terminal = await openPhoneTerminal(page);
  await startMouseTracking(page, terminal);
  await page.evaluate(() => navigator.clipboard.writeText("nothing"));
  await input(page).blur();
  await browse(page).click();
  await expect(browse(page)).toHaveAttribute("aria-pressed", "true");

  const touch = await Touch.on(page);
  const at = await pointOnRowStart(terminal, "delta epsilon zeta");
  const end = await rowEnd(terminal, "delta epsilon zeta");
  await touch.down(at);
  await expect.poll(() => painted(page).count()).toBeGreaterThan(0);
  await touch.drag(at, end);
  await touch.up(end);
  const menu = page.getByRole("menu", { name: "Selected text" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Paste" })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Copy" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("epsilon zeta");
  await expect(input(page)).not.toBeFocused();

  await browse(page).click();
  await tapReaches(touch, terminal, "alpha beta gamma");
  await nothingReachedFrom(terminal, "delta epsilon zeta");
  await stopMouseTracking(page);
});

test("browsing read-only, a swipe scrolls the scrollback and the program hears nothing", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await page.keyboard.type("seq 1 200\r");
  await expect(terminal).toContainText("200", { timeout: 15_000 });
  await startMouseTracking(page, terminal);
  const viewport = page.locator("[data-slot=terminal-viewport]");
  await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await input(page).blur();
  await browse(page).click();
  await expect(browse(page)).toHaveAttribute("aria-pressed", "true");

  const touch = await Touch.on(page);
  const before = await viewport.evaluate((el) => el.scrollTop);
  const at = await pointOnRowStart(terminal, "delta epsilon zeta");
  await touch.down(at);
  // A quick flick, as a thumb swipes: the scroll carries on after the finger lifts (#1491).
  await touch.drag(at, { x: at.x, y: at.y + 200 }, 3);
  await touch.up({ x: at.x, y: at.y + 200 });
  await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeLessThan(before);
  const scrolled = await restingScrollTop(viewport);
  await expect(painted(page)).toHaveCount(0);

  const jump = page.getByRole("button", { name: /^Jump to bottom/ });
  await jump.click();
  // Back at the live bottom the button goes; only then do the rows a tap aims at stay where they were measured.
  await expect(jump).toHaveCount(0);
  expect(await restingScrollTop(viewport)).toBeGreaterThan(scrolled);
  await browse(page).click();
  // The swipe began on the "delta" row and moved down over the rows below it; the barrier tap lands above them.
  await tapReaches(touch, terminal, "alpha beta gamma");
  await nothingReachedFrom(terminal, "delta epsilon zeta");
  await stopMouseTracking(page);
});
