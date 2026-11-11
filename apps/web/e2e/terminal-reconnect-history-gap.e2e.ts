import { execFileSync } from "node:child_process";
import type { Locator, Page } from "@playwright/test";
import { endAgent } from "./agents.ts";
import { E2E_HOST_ENV } from "./config.ts";
import { expect, laidOutBox, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { readSavedEnv } from "./saved-env.ts";

test.use({ serviceWorkers: "block" });

const opened: string[] = [];
test.afterEach(() => {
  for (const address of opened.splice(0)) endAgent("host", address);
});

const GAP = /Output from while the connection was down may be missing here/;

/** The core's own screen of a terminal, read with hc: what the program printed, whether or not the page has it. */
function coreScreen(address: string): string {
  const { hc, env } = readSavedEnv(E2E_HOST_ENV);
  return execFileSync(hc, ["read", address], { env: { ...process.env, ...env }, encoding: "utf8" });
}

/** The text of the terminal's rows whose top is within half a row of `y` (px from the page's top), above and below it. */
const rowsAround = (terminal: Locator, y: number): Promise<{ above: string; below: string }> =>
  terminal.evaluate((element, at) => {
    const rows = [...element.querySelectorAll(".term-grid .term-row")].map((row) => ({
      rect: row.getBoundingClientRect(),
      text: row.textContent ?? "",
    }));
    const below = rows.find((row) => Math.abs(row.rect.top - at) < row.rect.height / 2);
    const above = rows.find((row) => Math.abs(row.rect.bottom - at) < row.rect.height / 2);
    return { above: above?.text ?? "", below: below?.text ?? "" };
  }, y);

/**
 * Scrolls the terminal so the mark's row sits mid-view, and returns the mark's top edge in px from the page's top once
 * it has moved there (the marks follow the scroll a frame later).
 */
async function markInView(page: Page, terminal: Locator): Promise<number> {
  const mark = page.getByRole("separator", { name: GAP });
  const row = Number(await mark.getAttribute("data-history-gap"));
  const rowHeight = (await laidOutBox(terminal.locator(".term-row:not(.term-scrollback-row)").first())).height;
  await terminal.evaluate(
    (element, { at, height }) => {
      element.scrollTop = Math.max(0, at * height - element.clientHeight / 2);
    },
    { at: row, height: rowHeight },
  );
  const box = await laidOutBox(terminal);
  await expect
    .poll(async () => {
      const top = (await laidOutBox(mark)).y;
      return top > box.y + rowHeight && top < box.y + box.height - rowHeight;
    })
    .toBe(true);
  return (await laidOutBox(mark)).y;
}

/**
 * hc's attach has no cursor to resume from, so a reattach repaints the screen alone (#1997): what scrolled off the core's
 * screen while the line was down never reaches the view. Until the core can resume (herdrdev/herdr-core#233), the view
 * marks the place, between the history it kept and the screen painted after the reconnect, and the mark stays between
 * those lines as more output pushes them up (#2033).
 */
test("a reconnect marks where output from while the line was down may be missing (#2033)", async ({ page }) => {
  const link = await routeHcSocket(page);
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = (await terminal.getAttribute("data-terminal")) ?? "";
  opened.push(address);
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type("for i in $(seq 1 200); do echo kept-$i; done");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("kept-200", { timeout: 30_000 });
  // A first attach has nothing missing: no mark.
  await expect(page.getByRole("separator", { name: GAP })).toHaveCount(0);

  // The line goes down, and while it is down the program prints far more than a screen.
  await page.keyboard.type("sleep 1; for i in $(seq 1 400); do echo away-$i; done");
  await page.keyboard.press("Enter");
  await link.drop(true);
  await expect.poll(() => coreScreen(address), { timeout: 30_000 }).toContain("away-400");
  link.restore();
  // Output after the reattach comes behind its repaint on the same stream: once it shows, the repaint has been drawn.
  await page.keyboard.type("echo back-$((1+1))");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("back-2", { timeout: 30_000 });

  // The mark sits on the line between the kept history and the repainted screen, whose first row is from late in the
  // run: the lines before it never reached the view.
  const mark = page.getByRole("separator", { name: GAP });
  await expect(mark).toHaveCount(1);
  const first = await rowsAround(terminal, await markInView(page, terminal));
  expect(first.above).not.toMatch(/away-/);
  expect(Number(/away-(\d+)/.exec(first.below)?.[1] ?? 0)).toBeGreaterThan(1);

  // More output pushes those lines up into history; the mark goes with them.
  await page.keyboard.type("for i in $(seq 1 30); do echo later-$i; done");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("later-30", { timeout: 30_000 });
  expect(await rowsAround(terminal, await markInView(page, terminal))).toEqual(first);
});
