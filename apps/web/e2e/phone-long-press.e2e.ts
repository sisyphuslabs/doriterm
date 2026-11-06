import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { openPhoneTerminal, PHONE } from "./phone-key-bar.ts";
import { pointOnRowStart, rowEnd } from "./terminal-points.ts";
import { Touch } from "./touch.ts";

test.use({ serviceWorkers: "block", ...PHONE, permissions: ["clipboard-read", "clipboard-write"] });

const painted = (page: Page) => page.locator(".term-selection-cells > div");
const menu = (page: Page) => page.getByRole("menu", { name: "Selected text" });
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
/** A finger that stays down this long is still holding on purpose, well past the moment a touch becomes a tap. */
const HELD_MS = 1_200;

test("a held touch selects the word under the finger, and Copy puts it on the clipboard", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await page.keyboard.type("printf 'alpha%s\\n' '-line more'\r");
  await expect(terminal).toContainText("alpha-line more", { timeout: 15_000 });
  await page.evaluate(() => navigator.clipboard.writeText("nothing"));
  await expect(painted(page)).toHaveCount(0);

  const at = await pointOnRowStart(terminal, "alpha-line more");
  const touch = await Touch.on(page);
  await touch.down(at);
  await expect.poll(() => painted(page).count()).toBeGreaterThan(0);
  await touch.up(at);

  await expect(menu(page)).toBeVisible();
  await menu(page).getByRole("menuitem", { name: "Copy" }).click();
  await expect.poll(() => clipboard(page)).toBe("alpha");
});

test("a lift long after the hold still copies what it selected", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await page.keyboard.type("printf 'alpha%s\\n' '-line more'\r");
  await expect(terminal).toContainText("alpha-line more", { timeout: 15_000 });
  await page.evaluate(() => navigator.clipboard.writeText("nothing"));

  const at = await pointOnRowStart(terminal, "alpha-line more");
  const touch = await Touch.on(page);
  await touch.down(at);
  await expect.poll(() => painted(page).count()).toBeGreaterThan(0);
  await page.waitForTimeout(HELD_MS);
  await touch.up(at);

  await expect(menu(page)).toBeVisible();
  await menu(page).getByRole("menuitem", { name: "Copy" }).click();
  await expect.poll(() => clipboard(page)).toBe("alpha");
});

test("a drag after the hold takes what it reached", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await page.keyboard.type("printf 'drag-%s\\n' 'alpha beta gamma'\r");
  await expect(terminal).toContainText("drag-alpha beta gamma", { timeout: 15_000 });
  await page.evaluate(() => navigator.clipboard.writeText("nothing"));

  const at = await pointOnRowStart(terminal, "drag-alpha beta gamma");
  const end = await rowEnd(terminal, "drag-alpha beta gamma");
  const touch = await Touch.on(page);
  await touch.down(at);
  await expect.poll(() => painted(page).count()).toBeGreaterThan(0);
  await touch.drag(at, end);
  await touch.up(end);
  await expect(menu(page)).toBeVisible();
  await menu(page).getByRole("menuitem", { name: "Copy" }).click();
  await expect.poll(() => clipboard(page)).toContain("beta");
});

test("a tap still types and a swipe still scrolls the scrollback", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  const touch = await Touch.on(page);
  const viewport = page.locator("[data-slot=terminal-viewport]");

  await page.locator("[data-terminal]").click();
  await expect(page.locator("[data-terminal] textarea")).toBeFocused();
  await expect(painted(page)).toHaveCount(0);
  await page.keyboard.type("echo tap-$((2+2))");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("tap-4", { timeout: 15_000 });

  await page.keyboard.type("seq 1 200\r");
  await expect(terminal).toContainText("200", { timeout: 15_000 });
  await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const before = await viewport.evaluate((el) => el.scrollTop);
  const at = await pointOnRowStart(terminal, "200");
  await touch.down(at);
  await touch.drag(at, { x: at.x, y: at.y + 260 });
  await touch.up({ x: at.x, y: at.y + 260 });
  await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeLessThan(before);
  await expect(painted(page)).toHaveCount(0);
});
