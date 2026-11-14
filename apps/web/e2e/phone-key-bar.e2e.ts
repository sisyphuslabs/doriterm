import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { expectTouchTargets, key, keysBar, openPhoneTerminal, PHONE, showKeyboard } from "./phone-key-bar.ts";

test.use({ serviceWorkers: "block", ...PHONE });

const BAR_KEYS = [
  "Control",
  "Shift",
  "Tab",
  "Escape",
  "Arrow left",
  "Arrow up",
  "Arrow down",
  "Arrow right",
  "Arrow keys",
  "Paste",
  "Switch session",
  "Send",
  "Hide keyboard",
];
const PAD_KEYS = ["Delete", "Up arrow", "Clear screen", "Left arrow", "Return", "Right arrow", "Down arrow"];
/** Send belongs to the fixed input column; the keyboard key has its own column. */
const FIXED_KEYS = ["Send", "Hide keyboard"];
const SCROLL_KEYS = BAR_KEYS.length - FIXED_KEYS.length;
const names = (scope: Locator) =>
  scope.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") ?? ""));

for (const width of [390, 320]) {
  test(`at ${width} the keys bar is one pill of 44 pt keys inside the screen`, async ({ page }) => {
    await openPhoneTerminal(page, width);
    const bar = keysBar(page);
    await expect(bar).toBeVisible();
    expect(await names(bar)).toEqual(expect.arrayContaining(BAR_KEYS));
    await expectTouchTargets(bar);
    const shown = await page.locator('[data-slot="terminal-keys-scroll"]').evaluate((el) => {
      const edge = el.getBoundingClientRect();
      return [...el.querySelectorAll("button")]
        .filter((button) => button.getBoundingClientRect().right <= edge.right + 1)
        .map((button) => button.getAttribute("aria-label"));
    });
    // The fixed input leaves room for the first three keys at 390; the rest are reached by swiping.
    if (width === 390) {
      // The keys in the row's own order, of which the first few fit: the row swipes for the rest (#195).
      expect(shown.slice(0, 3)).toEqual(
        process.platform === "darwin" ? ["Control", "Command", "Shift"] : ["Control", "Shift", "Tab"],
      );
      expect(shown.length).toBeLessThan(SCROLL_KEYS);
    }
    const box = await bar.boundingBox();
    // With the keyboard up the header stays above the bar: the terminal keeps the room between them.
    const head = await page.getByRole("banner").boundingBox();
    expect((head?.y ?? 0) + (head?.height ?? Infinity)).toBeLessThanOrEqual(box?.y ?? 0);
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? Infinity)).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

test("the bar rides on the soft keyboard; with the keyboard down it stays under the terminal (#2499)", async ({
  page,
}) => {
  await openPhoneTerminal(page);
  const bar = keysBar(page);
  await expect(bar).toBeVisible();
  const bottom = async (): Promise<number> => {
    const box = await bar.boundingBox();
    return Math.round((box?.y ?? 0) + (box?.height ?? 0));
  };
  await expect.poll(bottom).toBe(844 - 336);

  // The keyboard closes on its own (its hide key): the bar falls with it, to under the terminal, its last key now the
  // one that raises the keyboard.
  await showKeyboard(page, 0);
  const show = bar.getByRole("button", { name: "Show keyboard", exact: true });
  await expect(show).toBeVisible();
  await expect.poll(bottom).toBeGreaterThan(844 - 336);
  const toggle = await show.boundingBox();
  expect(toggle?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect((toggle?.x ?? 0) + (toggle?.width ?? 0)).toBeGreaterThan(390 - 60);

  await show.click();
  await expect(bar).toBeVisible();
  await expect.poll(bottom).toBe(844 - 336);
  await expect(page.locator("[data-terminal] textarea")).toBeFocused();
  await key(page, "Hide keyboard").click();
  await expect(bar).toBeVisible();
  await expect(show).toBeVisible();
});

test("a browser that shrinks the layout viewport for the keyboard shows the bar too", async ({ page }) => {
  await openPhoneTerminal(page, 390, "resize");
  const bar = keysBar(page);
  await expect(page.locator("[data-terminal] textarea")).toBeFocused();
  await expect(key(page, "Hide keyboard")).toHaveCount(0);

  // The keyboard button raises it: the page itself is 336 px shorter, and the visual viewport is all of it (#1375).
  await key(page, "Show keyboard").click();
  await page.setViewportSize({ width: 390, height: 844 - 336 });
  await expect(key(page, "Hide keyboard")).toBeVisible();
  const box = await bar.boundingBox();
  expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(844 - 336);

  // It closes by its own key: the page grows back and the bar stays, under the terminal (#2499).
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(key(page, "Show keyboard")).toBeVisible();
  await expect(bar).toBeVisible();
});

test("the D-pad toggle lays a 3x3 pad over the terminal", async ({ page }) => {
  await openPhoneTerminal(page);
  const toggle = key(page, "Arrow keys");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const pad = page.getByRole("group", { name: "Arrow keys" });
  await expect(pad).toBeVisible();
  const order = await pad
    .locator(":scope > *")
    .evaluateAll((cells) => cells.map((cell) => cell.getAttribute("aria-label") ?? ""));
  expect(order).toEqual([
    "Delete",
    "Up arrow",
    "Clear screen",
    "Left arrow",
    "Return",
    "Right arrow",
    "",
    "Down arrow",
    "",
  ]);
  expect(await names(pad)).toEqual(PAD_KEYS);
  await expectTouchTargets(pad);
  // Pressing pad keys keeps the keyboard up: the terminal keeps focus.
  await key(page, "Up arrow").click();
  await expect(page.locator("[data-terminal] textarea")).toBeFocused();
  await toggle.click();
  await expect(pad).toHaveCount(0);
});

test("swiping the bar sideways reveals ~ | / - behind an edge fade", async ({ page }) => {
  await openPhoneTerminal(page);
  const scroller = page.locator('[data-slot="terminal-keys-scroll"]');
  await expect(scroller).toHaveAttribute("data-fade", "end");
  await scroller.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
  await expect(scroller).toHaveAttribute("data-fade", "start");
  // The narrow row reveals each character when scrolled into view.
  const visible = await scroller.evaluate((el) => {
    const edge = el.getBoundingClientRect();
    const buttons = [...el.querySelectorAll("button")];
    const tilde = buttons.find((button) => button.textContent === "~");
    el.scrollLeft += (tilde?.getBoundingClientRect().left ?? edge.left) - edge.left;
    return buttons
      .filter((button) => {
        const box = button.getBoundingClientRect();
        return box.left >= edge.left - 1 && box.right <= edge.right + 1;
      })
      .map((button) => button.textContent);
  });
  expect(visible).toEqual(expect.arrayContaining(["~", "|", "/"]));
  await key(page, "Hyphen").scrollIntoViewIfNeeded();
  await expect(key(page, "Hyphen")).toBeInViewport({ ratio: 1 });
});

test("reduced motion moves the bar without animating it", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openPhoneTerminal(page);
  const durations = await keysBar(page).evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(durations.split(",").every((value) => Number.parseFloat(value) === 0)).toBe(true);
});
