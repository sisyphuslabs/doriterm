import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { reportedRows, reportRowOf, startMouseTracking, stopMouseTracking } from "./mouse-tracking.ts";
import { key, openPhoneTerminal, PHONE } from "./phone-key-bar.ts";
import { pointOnRowStart } from "./terminal-points.ts";
import { Touch } from "./touch.ts";

test.use({ serviceWorkers: "block", ...PHONE });

const browse = (page: Page) => key(page, "Read-only");
const input = (page: Page) => page.locator("[data-terminal] textarea");

test("the terminal pans and pinch-zooms only, while the rest of the page keeps the base's manipulation", async ({
  page,
}) => {
  const terminal = await openPhoneTerminal(page);
  const touchAction = terminal.evaluate((el) => getComputedStyle(el.closest(".wterm") ?? el).touchAction);
  expect(await touchAction).toBe("pan-y pinch-zoom");
  // The base rule is #1382's `* { touch-action: manipulation }`; the terminal's rule is the more specific one.
  expect(await page.getByRole("banner").evaluate((el) => getComputedStyle(el).touchAction)).toBe("manipulation");
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
  // A tap after browsing is reported; anything the wheel sent would have been echoed before it.
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
