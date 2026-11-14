import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { hcOn } from "./machine-switch.ts";
import { reportedRows, reportRowOf, startMouseTracking, stopMouseTracking } from "./mouse-tracking.ts";
import { key, keysBar, openPhoneTerminal, PHONE, settledGrid } from "./phone-key-bar.ts";
import { pointOnRowStart, rowEnd } from "./terminal-points.ts";
import { Touch } from "./touch.ts";

test.use({ serviceWorkers: "block", ...PHONE, permissions: ["clipboard-read", "clipboard-write"] });

const browse = (page: Page) => key(page, "Read-only");
const painted = (page: Page) => page.locator(".term-selection-cells > div");
const input = (page: Page) => page.locator("[data-terminal] textarea");

/**
 * Starts listening for the view's next scrollend; call it before the gesture that scrolls the view. The returned wait
 * gives the view's scrollTop once that scrollend has fired and the view holds still across two frames. A swipe that
 * lets go flings on: until it stops, a jump is overtaken by it, and the browser spends the next tap on stopping it
 * rather than handing it to the page (#1491). Two equal frames alone do not prove the fling is over, as its tail can
 * hold a value for a frame and then move on; the browser's scrollend does (#1537).
 */
async function scrollEnd(viewport: Locator): Promise<() => Promise<number>> {
  await viewport.evaluate((el) => {
    const view = el as HTMLElement & { scrollEnded?: boolean };
    view.scrollEnded = false;
    el.addEventListener(
      "scrollend",
      () => {
        view.scrollEnded = true;
      },
      { once: true },
    );
  });
  return async () => {
    let settled = Number.NaN;
    await expect
      .poll(async () => {
        const seen = await viewport.evaluate(async (el) => {
          const first = el.scrollTop;
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
          const ended = (el as HTMLElement & { scrollEnded?: boolean }).scrollEnded === true;
          return { ended: ended && el.scrollTop === first, top: el.scrollTop };
        });
        settled = seen.top;
        return seen.ended;
      })
      .toBe(true);
    return settled;
  };
}

/**
 * The program hears a tap on `row` (the browser turns a tap into the mouse events the renderer reports). The tap is
 * aimed once the grid is the size the core holds: leaving browse mode brings the keys panel back under the terminal,
 * which shrinks it, and a point read before that fit lands on rows that have since moved (#2499).
 */
async function tapReaches(touch: Touch, terminal: Locator, row: string): Promise<void> {
  await settledGrid(terminal.page(), terminal);
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
  const swipeSettled = await scrollEnd(viewport);
  await touch.down(at);
  await touch.drag(at, { x: at.x, y: at.y + 200 });
  await touch.up({ x: at.x, y: at.y + 200 });
  await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeLessThan(before);
  await expect(painted(page)).toHaveCount(0);
  const scrolled = await swipeSettled();

  const jump = page.getByRole("button", { name: /^Jump to bottom/ });
  const jumpSettled = await scrollEnd(viewport);
  await jump.click();
  await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(scrolled);
  // At the bottom, and still there: the button goes once the view is back at the live end.
  await expect(jump).toHaveCount(0);
  await jumpSettled();
  await browse(page).click();
  // The swipe began on the "delta" row and moved down over the rows below it; the barrier tap lands above them.
  await tapReaches(touch, terminal, "alpha beta gamma");
  await nothingReachedFrom(terminal, "delta epsilon zeta");
  await stopMouseTracking(page);
});

test("entering browse mode in history keeps its position and a held touch selects there (#1368)", async ({
  page,
}, info) => {
  const terminal = await openPhoneTerminal(page);
  const address = await terminal.getAttribute("data-terminal");
  if (address === null) throw new Error("terminal has no address");
  try {
    hcOn("host", [
      "send",
      address,
      "stty -echo; printf '\\033[?1004h'; for i in $(seq 1 300); do printf 'history-%03d-copy\\n' $i; done; cat >/dev/null",
    ]);
    await expect(terminal).toContainText("history-300-copy", { timeout: 15_000 });
    const settled = await scrollEnd(terminal);
    await terminal.evaluate((element) => {
      const row = element.querySelector(".term-row");
      if (row === null) throw new Error("terminal has no rows");
      element.scrollTop -= row.getBoundingClientRect().height * 50;
    });
    await expect(page.getByRole("button", { name: /^Jump to bottom/ })).toBeVisible();
    const scrolled = await settled();
    await input(page).blur();
    await expect.poll(() => terminal.evaluate((element) => element.scrollTop)).toBe(scrolled);
    await browse(page).click();
    await expect(terminal).toHaveAttribute("data-browsing", "true");
    const text = await terminal.evaluate((element) => {
      const top = element.getBoundingClientRect().top;
      return (
        [...element.querySelectorAll(".term-row")]
          .find((row) => row.getBoundingClientRect().top > top + 60)
          ?.textContent?.trim() ?? ""
      );
    });
    expect(text).toMatch(/^history-\d{3}-copy$/);
    const touch = await Touch.on(page);
    const at = await pointOnRowStart(terminal, text);
    const end = await rowEnd(terminal, text);
    await touch.down(at);
    await expect.poll(() => painted(page).count()).toBeGreaterThan(0);
    await touch.drag(at, end);
    await touch.up(end);
    await expect.poll(() => terminal.evaluate((element) => element.scrollTop)).toBe(scrolled);
    await page.screenshot({ path: info.outputPath("phone-selected-history.png") });
    await page.getByRole("menu", { name: "Selected text" }).getByRole("menuitem", { name: "Copy" }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(text);
    await expect(input(page)).not.toBeFocused();
  } finally {
    hcOn("host", ["kill", address]);
  }
});
