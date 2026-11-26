import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import {
  expectTouchTargets,
  key,
  keysBar,
  openPhoneTerminal,
  PHONE,
  scrollDocument,
  showKeyboard,
} from "./phone-key-bar.ts";

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
  "Return",
  "Hide keyboard",
  "Type in a field",
];
const PAD_KEYS = ["Delete", "Up arrow", "Clear screen", "Left arrow", "Enter", "Right arrow", "Down arrow"];
/** Return, the keyboard toggle and the input-card toggle live in the fixed Actions pill. */
const FIXED_KEYS = ["Return", "Hide keyboard", "Type in a field"];
const SCROLL_KEYS = BAR_KEYS.length - FIXED_KEYS.length;
const names = (scope: Locator) =>
  scope.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") ?? ""));

async function expectPagedKey(page: Page, scroller: Locator, label: string): Promise<void> {
  const button = key(page, label);
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeInViewport({ ratio: 1 });
  expect(Number(await scroller.getAttribute("data-page"))).toBeGreaterThan(1);
}

for (const width of [390, 320]) {
  test(`at ${width} the keys bar is two pills of 44 pt keys in one row inside the screen`, async ({ page }) => {
    await openPhoneTerminal(page, width);
    const bar = keysBar(page);
    await expect(bar).toBeVisible();
    expect(await names(bar)).toEqual(expect.arrayContaining(BAR_KEYS));
    await expectTouchTargets(bar);
    const keysPill = bar.getByRole("group", { name: "Keys", exact: true });
    const actionsPill = bar.getByRole("group", { name: "Actions", exact: true });
    const [keysBox, actionsBox] = await Promise.all([keysPill.boundingBox(), actionsPill.boundingBox()]);
    if (keysBox === null || actionsBox === null) throw new Error("pill not laid out");
    expect(Math.abs(keysBox.y - actionsBox.y)).toBeLessThanOrEqual(1);
    expect(keysBox.x + keysBox.width).toBeLessThan(actionsBox.x);
    expect(await names(actionsPill)).toEqual(FIXED_KEYS);
    const shown = await page.locator('[data-slot="terminal-keys-scroll"]').evaluate((el) => {
      const edge = el.getBoundingClientRect();
      return [...el.querySelectorAll("button")]
        .filter((button) => {
          const rect = button.getBoundingClientRect();
          return rect.left >= edge.left - 1 && rect.right <= edge.right + 1;
        })
        .map((button) => button.getAttribute("aria-label"));
    });
    // The key pill shows one page at a time; the rest are reached by paging sideways.
    if (width === 390) {
      // The keys in the row's own order, of which the first page fits: the row pages for the rest (#195, #2778).
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

test("the bar stays on the keyboard when the document scrolls after the keyboard came up (#2847)", async ({ page }) => {
  await openPhoneTerminal(page);
  const bar = keysBar(page);
  await expect(bar).toBeVisible();
  // The bar's bottom and the keyboard's top, both in the page: the document's scroll moves the keys with the page.
  const gap = (): Promise<number> =>
    bar.evaluate((element) => {
      const viewport = window.visualViewport;
      const keyboardTop = (viewport?.pageTop ?? 0) + (viewport?.height ?? 0);
      return Math.round(element.getBoundingClientRect().bottom + window.scrollY - keyboardTop);
    });
  await expect.poll(gap).toBe(0);
  // iOS's order: the keyboard's resize came first; the document scrolls afterwards, with no visualViewport event.
  await scrollDocument(page, 49);
  await expect.poll(gap).toBe(0);
  await scrollDocument(page, 0);
  await expect.poll(gap).toBe(0);
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

// Our own 3x3 pad, not the Herdr app's inverted T (Q, 2026-11-26), in the bubble over its key that #2778 brought.
test("the D-pad toggle opens the 3x3 pad in a bubble over its key", async ({ page }) => {
  await openPhoneTerminal(page);
  const toggle = key(page, "Arrow keys");
  await toggle.scrollIntoViewIfNeeded();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const pad = page.getByRole("group", { name: "Arrow keys", exact: true });
  await expect(pad).toBeVisible();
  const order = await pad
    .locator(":scope > :not([data-slot=pad-tail])")
    .evaluateAll((cells) => cells.map((cell) => cell.getAttribute("aria-label") ?? ""));
  expect(order).toEqual([
    "Delete",
    "Up arrow",
    "Clear screen",
    "Left arrow",
    "Enter",
    "Right arrow",
    "",
    "Down arrow",
    "",
  ]);
  expect(await names(pad)).toEqual(PAD_KEYS);
  await expect(pad.locator('[data-slot="pad-tail"]')).toHaveCount(1);
  const [padBox, toggleBox, up, left, down, right] = await Promise.all([
    pad.boundingBox(),
    toggle.boundingBox(),
    pad.getByRole("button", { name: "Up arrow", exact: true }).boundingBox(),
    pad.getByRole("button", { name: "Left arrow", exact: true }).boundingBox(),
    pad.getByRole("button", { name: "Down arrow", exact: true }).boundingBox(),
    pad.getByRole("button", { name: "Right arrow", exact: true }).boundingBox(),
  ]);
  if (padBox === null || toggleBox === null || up === null || left === null || down === null || right === null) {
    throw new Error("arrow pad not laid out");
  }
  // Up over Enter over Down in the middle column; Left, Enter and Right on the middle row.
  expect(padBox.y + padBox.height).toBeLessThanOrEqual(toggleBox.y);
  expect(up.y + up.height).toBeLessThanOrEqual(left.y);
  expect(left.y + left.height).toBeLessThanOrEqual(down.y);
  expect(Math.abs(up.x - down.x)).toBeLessThanOrEqual(1);
  expect(left.x + left.width).toBeLessThanOrEqual(down.x);
  expect(down.x + down.width).toBeLessThanOrEqual(right.x);
  expect(Math.abs(left.y - right.y)).toBeLessThanOrEqual(1);
  await expectTouchTargets(pad);
  // Pressing pad keys keeps the keyboard up: the terminal keeps focus.
  await key(page, "Up arrow").click();
  await expect(page.locator("[data-terminal] textarea")).toBeFocused();
  await toggle.click();
  await expect(pad).toHaveCount(0);
});

test("paging the key pill sideways moves its dots and reveals ~ | / -", async ({ page }) => {
  await openPhoneTerminal(page);
  const keysPill = keysBar(page).getByRole("group", { name: "Keys", exact: true });
  const scroller = keysPill.locator('[data-slot="terminal-keys-scroll"]');
  const total = Number(await scroller.getAttribute("data-pages"));
  expect(total).toBeGreaterThan(1);
  await expect(scroller).toHaveAttribute("data-page", "1");
  await expect(keysPill.locator('[data-slot="page-dot"]')).toHaveCount(total);
  await expect(scroller.locator('[data-slot="key-page"]')).toHaveCount(total);

  await scroller.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
  await expect(scroller).toHaveAttribute("data-page", String(total));
  // Paging through the key pill reveals each character key fully inside the viewport.
  await expectPagedKey(page, scroller, "Tilde");
  await expectPagedKey(page, scroller, "Vertical bar");
  await expectPagedKey(page, scroller, "Slash");
  await expectPagedKey(page, scroller, "Hyphen");
});

test("reduced motion moves the bar without animating it", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openPhoneTerminal(page);
  const durations = await keysBar(page).evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(durations.split(",").every((value) => Number.parseFloat(value) === 0)).toBe(true);
});
