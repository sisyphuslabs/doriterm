import type { Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("a drag after the hold keeps the drag its own when the program redraws the row under the finger (#2057)", async ({
  page,
}, info) => {
  const terminal = await openPhoneTerminal(page);
  await page.keyboard.type("seq 1 120\r");
  await expect(terminal).toContainText("120", { timeout: 15_000 });
  // The program draws the row again once the hold has picked its word, as a prompt, a clock or a progress line does.
  const redraw = join(tmpdir(), `long-press-redraw-${info.testId}-${info.repeatEachIndex}`);
  await page.keyboard.type(
    `printf 'redraw-%s' 'alpha beta gamma'; until [ -e ${redraw} ]; do sleep 0.05; done; printf '\\r\\033[Kredraw-%s!' 'alpha beta gamma'; cat\r`,
  );
  await expect(terminal).toContainText("redraw-alpha beta gamma", { timeout: 15_000 });
  await page.evaluate(() => {
    const seen = { touched: null as EventTarget | null, moves: [] as Event[] };
    Object.assign(window, { dragSeen: seen });
    // The browser sends a touch's moves to the node it came down on, redrawn away or not: they are counted there.
    window.addEventListener(
      "touchstart",
      (event) => {
        seen.touched = event.target;
        event.target?.addEventListener("touchmove", (move) => seen.moves.push(move), { passive: true });
      },
      { capture: true, passive: true },
    );
  });
  const seen = () =>
    page.evaluate(() => {
      const { touched, moves } = (window as unknown as { dragSeen: { touched: EventTarget | null; moves: Event[] } })
        .dragSeen;
      return {
        redrawn: touched instanceof Node && !touched.isConnected,
        moves: moves.length,
        cancelled: moves.filter((move) => move.defaultPrevented).length,
      };
    });
  await page.evaluate(() => navigator.clipboard.writeText("nothing"));

  const at = await pointOnRowStart(terminal, "redraw-alpha beta gamma");
  const end = await rowEnd(terminal, "redraw-alpha beta gamma");
  const touch = await Touch.on(page);
  await touch.down(at);
  await expect.poll(() => painted(page).count()).toBeGreaterThan(0);
  await writeFile(redraw, "");
  await expect(terminal).toContainText("redraw-alpha beta gamma!");
  await expect.poll(async () => (await seen()).redrawn).toBe(true);
  await touch.drag(at, end);
  await touch.up(end);
  // Every move of the drag was the selection's: one left to the browser lets it take the drag as a pan.
  const { moves, cancelled } = await seen();
  expect(moves).toBeGreaterThan(0);
  expect(cancelled).toBe(moves);
  await expect(menu(page)).toBeVisible();
  await menu(page).getByRole("menuitem", { name: "Copy" }).click();
  await expect.poll(() => clipboard(page)).toContain("beta");
  await page.keyboard.press("Control+C");
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
