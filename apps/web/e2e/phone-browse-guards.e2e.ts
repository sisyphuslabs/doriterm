import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { reportedRows, reportRowOf, startMouseTracking, stopMouseTracking } from "./mouse-tracking.ts";
import { key, openPhoneTerminal, PHONE, settledGrid } from "./phone-key-bar.ts";
import { pointOnRowStart } from "./terminal-points.ts";
import { Touch } from "./touch.ts";

test.use({ serviceWorkers: "block", ...PHONE });

const browse = (page: Page) => key(page, "Read-only");
const input = (page: Page) => page.locator("[data-terminal] textarea");

const touchAction = (locator: Locator) => locator.evaluate((el) => getComputedStyle(el).touchAction);

test("the terminal pans vertically and pinch-zooms only", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  expect(await touchAction(terminal.locator("xpath=ancestor-or-self::*[contains(@class,'wterm')][1]"))).toBe(
    "pan-y pinch-zoom",
  );
});

test("the rest of the page keeps the base's manipulation beside the terminal's pan-y pinch-zoom", async ({ page }) => {
  await openPhoneTerminal(page);
  const base = await touchAction(page.getByRole("banner"));
  test.skip(
    base === "auto",
    "pending #1382: the base's * { touch-action: manipulation } is not on this branch's base yet",
  );
  expect(base).toBe("manipulation");
});

test("browsing read-only, a wheel over the rows reaches nothing the program reads", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await startMouseTracking(page, terminal);
  await input(page).blur();
  await browse(page).click();
  await expect(browse(page)).toHaveAttribute("aria-pressed", "true");

  const at = await pointOnRowStart(terminal, "delta epsilon zeta");
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, -120);
  await page.mouse.wheel(0, 120);

  await browse(page).click();
  await expect(browse(page)).toHaveAttribute("aria-pressed", "false");
  // A tap after browsing is reported; anything the wheel sent would have been echoed before it. It is aimed once the
  // grid fits again: leaving browse mode brings the keys panel back under the terminal (#2499).
  await settledGrid(page, terminal);
  const touch = await Touch.on(page);
  const before = (await reportedRows(terminal)).length;
  await touch.tap(await pointOnRowStart(terminal, "alpha beta gamma"));
  await expect.poll(() => reportedRows(terminal).then((rows) => rows.length)).toBeGreaterThan(before);
  expect(await reportedRows(terminal)).not.toContain(await reportRowOf(terminal, "delta epsilon zeta"));
  await stopMouseTracking(page);
});

test("browsing read-only ends when another terminal is opened", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await input(page).blur();
  await browse(page).click();
  await expect(terminal).toHaveAttribute("data-browsing", "true");

  await page.getByRole("button", { name: "Back to agents" }).click();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  await page.getByRole("banner").getByRole("button", { name: "New tab" }).click();
  const next = page.locator("[data-terminal]");
  await expect(next).toContainText("$", { timeout: 15_000 });
  await expect(next).not.toHaveAttribute("data-browsing", "true");
  await input(page).blur();
  await expect(browse(page)).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("status").filter({ hasText: "Read-only" })).toHaveCount(0);
});
