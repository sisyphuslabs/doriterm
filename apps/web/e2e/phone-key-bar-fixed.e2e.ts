import type { Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { expectTouchTargets, key, keysBar, openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

test.use({ serviceWorkers: "block", ...PHONE });

const scroller = (page: Page) => page.locator('[data-slot="terminal-keys-scroll"]');
const box = async (item: Locator) => await item.boundingBox();

const SCROLLED = ["Control", "Shift", "Tab", "Escape", "Paste"] as const;
/** The controls fixed at the row's end (#2604), outside the keys that scroll. */
const FIXED = ["Arrow keys", "Switch session", "Chat", "Hide keyboard"] as const;
const fixedSlots = (page: Page) => FIXED.map((name) => key(page, name));

for (const width of [320, 390]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`at ${width} in ${colorScheme} the row scrolls while the input and keyboard stay fixed`, async ({
      page,
    }, testInfo) => {
      await page.emulateMedia({ colorScheme });
      await openPhoneTerminal(page, width);
      await page.screenshot({ path: testInfo.outputPath("phone-keys.png") });
      await expect(page.getByLabel("Type into the terminal")).toHaveCount(0);
      await Promise.all(
        SCROLLED.map((name) => expect(scroller(page).getByRole("button", { name, exact: true })).toHaveCount(1)),
      );
      await expect(scroller(page).getByRole("textbox")).toHaveCount(0);
      await expect(scroller(page).getByRole("button", { name: "Hide keyboard", exact: true })).toHaveCount(0);
      await Promise.all(
        FIXED.map((name) => expect(scroller(page).getByRole("button", { name, exact: true })).toHaveCount(0)),
      );
      await expectTouchTargets(keysBar(page));

      const row = scroller(page);
      const dimensions = await row.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
      expect(dimensions.scroll).toBeGreaterThan(dimensions.client);

      // The real input sits beside the keyboard key, and scrolling the row moves neither.
      const before = await Promise.all(fixedSlots(page).map(box));
      await row.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
      await expect.poll(() => row.evaluate((el) => el.scrollLeft)).toBe(dimensions.scroll - dimensions.client);
      const after = await Promise.all(fixedSlots(page).map(box));
      expect(after).toEqual(before);
      for (const slot of after) {
        expect(slot?.x ?? -1).toBeGreaterThanOrEqual(0);
        expect((slot?.x ?? 0) + (slot?.width ?? Infinity)).toBeLessThanOrEqual(width);
      }
      const keyboard = after.at(-1);
      expect(keyboard?.x ?? 0).toBeGreaterThan(width - 60);
      // The arrow pad, Switch session, Chat and the keyboard's toggle, in that order.
      const ends = after.map((slot) => slot?.x ?? 0);
      expect(ends).toEqual([...ends].toSorted((a, b) => a - b));
      await page.screenshot({ path: testInfo.outputPath("phone-keys-scrolled.png") });
    });
  }
}

test("scrolled-in keys and the fixed slots both reach the terminal", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await page.keyboard.type("cat -v\r");
  await key(page, "Arrow keys").click();
  const pad = page.getByRole("group", { name: "Arrow keys" });
  for (const name of ["Left arrow", "Up arrow", "Down arrow", "Right arrow"]) {
    // oxlint-disable-next-line no-await-in-loop -- the keys reach the terminal in the order they are pressed
    await pad.getByRole("button", { name }).click();
  }
  await key(page, "Arrow keys").click();
  await page.keyboard.type("q\r");
  await expect(terminal).toContainText(/\^\[\[D\^\[\[A\^\[\[B\^\[\[Cq/, { timeout: 15_000 });

  await key(page, "Hide keyboard").click();
  await expect(key(page, "Show keyboard")).toBeVisible();
  await expect(key(page, "Hide keyboard")).toHaveCount(0);
});

test("ctrl and shift stay latched for the arrow that follows them", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await page.keyboard.type("cat -v\r");
  const ctrl = key(page, "Control");
  const shift = key(page, "Shift");
  await ctrl.click();
  await shift.click();
  await expect(ctrl).toHaveAttribute("aria-pressed", "true");
  await expect(shift).toHaveAttribute("aria-pressed", "true");
  await key(page, "Arrow keys").click();
  await page.getByRole("group", { name: "Arrow keys" }).getByRole("button", { name: "Right arrow" }).click();
  await expect(ctrl).toHaveAttribute("aria-pressed", "false");
  await expect(shift).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.type("q\r");
  await expect(terminal).toContainText(/\^\[\[1;6Cq/, { timeout: 15_000 });
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false, deviceScaleFactor: 1 });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`at desktop width in ${colorScheme} the terminal keeps its full workspace`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme });
      await page.goto("/");
      const terminal = await openNewTerminal(page);
      await page.keyboard.type("echo desktop-$((6*7))\r");
      await expect(terminal).toContainText("desktop-42");
      await expect(page.getByLabel("Type into the terminal")).toHaveCount(0);
      await expect(keysBar(page)).toHaveCount(0);
      await expect(page.getByRole("contentinfo")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
      await page.screenshot({ path: testInfo.outputPath("desktop-terminal.png") });
    });
  }
});
