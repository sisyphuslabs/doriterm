import { expect, openNewTerminal, test } from "./fixtures.ts";
import { pressShortcut } from "./platform-keys.ts";
import {
  centre,
  domOrder,
  dragPast,
  focusedAddress,
  fourTabs,
  openFour,
  order,
  rearranged,
  selectedIndex,
  strip,
  tabNumberChord,
  tabs,
} from "./tab-strip.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

test("dragging a tab past two others moves it there, keeps the selection, and the order survives a reload", async ({
  page,
}) => {
  const before = await fourTabs(page);
  const selected = await selectedIndex(page);
  await dragPast(page, tabs(page).nth(0), tabs(page).nth(2));
  await expect(tabs(page).nth(selected)).toHaveAttribute("aria-selected", "true");
  const after = rearranged(before, [1, 2, 0, 3]);
  expect(await order(page)).toEqual(after);
  await page.keyboard.press(await tabNumberChord(page, 3));
  expect(await focusedAddress(page)).toBe(before[0]);

  await page.reload();
  await expect(tabs(page)).toHaveCount(4, { timeout: 20_000 });
  await expect(tabs(page).nth(2)).toHaveAttribute("aria-selected", "true");
  expect(await order(page)).toEqual(after);
});

test("a press that wobbles 2 px is a click that selects, and Escape puts a dragged tab back", async ({ page }) => {
  const before = await fourTabs(page);
  const first = await centre(tabs(page).nth(1));
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  await page.mouse.move(first.x + 2, first.y);
  await page.mouse.up();
  await expect(tabs(page).nth(1)).toHaveAttribute("aria-selected", "true");

  // Drag a tab that is not the selected one: only those carry the hover wash.
  const other = await centre(tabs(page).nth(0));
  const end = await centre(tabs(page).nth(3));
  await page.mouse.move(other.x, other.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await expect(strip(page).locator("[data-dragging]")).toHaveCount(1);
  // Hovered under the pointer, the lifted tab still hides the tab it passes over.
  const fill = await strip(page)
    .locator("[data-dragging]")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(fill).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await order(page)).toEqual(before);
});

test("the keyboard moves the focused tab, focus stays on it, and its new place is announced", async ({ page }) => {
  const before = await fourTabs(page);
  await tabs(page).nth(0).focus();
  await pressShortcut(page, "tab.move:right");
  await expect(tabs(page).nth(1)).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: /^Moved .+ to position 2 of 4/ })).toHaveCount(1);
  await pressShortcut(page, "tab.move:right");
  await expect(tabs(page).nth(2)).toBeFocused();
  expect(await order(page)).toEqual(rearranged(before, [1, 2, 0, 3]));
});

test("a tab's menu moves it left or right, and an end of the strip disables the way out", async ({ page }) => {
  const before = await fourTabs(page);
  await tabs(page).nth(0).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Move tab left" })).toBeDisabled();
  await page.getByRole("menuitem", { name: "Move tab right" }).click();
  await expect(tabs(page).nth(1)).toBeFocused();
  expect(await order(page)).toEqual(rearranged(before, [1, 0, 2, 3]));
  await tabs(page).nth(3).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Move tab right" })).toBeDisabled();
  await page.keyboard.press("Escape");
});

test("under reduced motion neighbours stay put and a caret marks where the tab lands", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fourTabs(page);
  const start = await centre(tabs(page).nth(0));
  const end = await centre(tabs(page).nth(2));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.right - 4, end.y, { steps: 12 });
  await expect(strip(page).locator("[data-tab-drop-caret]")).toBeVisible();
  const translates = await strip(page)
    .locator("[data-tab-id]:not([data-dragging])")
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).translate));
  expect(translates.every((value) => value === "none")).toBe(true);
  await page.mouse.up();
});

test("on macOS the move chord stays with a text field, so the palette keeps its text editing, and from the terminal it moves the tab", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" });
  });
  await openFour(page);
  const before = await domOrder(page);
  await pressShortcut(page, "app.palette");
  const field = page.getByRole("combobox");
  await expect(field).toBeFocused();
  await field.fill("hello world");
  // What the field itself sees of the chord: on a Mac an untouched ⌘⇧← selects to the start of the line.
  await field.evaluate((element) => {
    element.addEventListener("keydown", (event) => {
      if (event instanceof KeyboardEvent && event.key === "ArrowLeft" && element instanceof HTMLElement)
        element.dataset["seen"] = `prevented=${String(event.defaultPrevented)}`;
    });
  });
  await pressShortcut(page, "tab.move:left");
  await expect(field).toHaveAttribute("data-seen", "prevented=false");
  await expect(field).toHaveValue("hello world");
  expect(await domOrder(page)).toEqual(before);

  await page.keyboard.press("Escape");
  await expect(field).toBeHidden();
  await page.locator('[data-focused="true"] [data-terminal]').getByRole("textbox").focus();
  await pressShortcut(page, "tab.move:left");
  await expect.poll(() => domOrder(page)).toEqual(rearranged(before, [0, 1, 3, 2]));
});

test("a drop let go below the strip leaves the next Enter or click on a tab alone, and a drop onto itself never selects", async ({
  page,
}) => {
  await openFour(page);
  const before = await domOrder(page);
  const from = await centre(tabs(page).nth(0));
  const past = await centre(tabs(page).nth(2));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(past.right - 4, past.y, { steps: 12 });
  await page.mouse.move(past.right - 4, past.y + 250, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => domOrder(page)).toEqual(rearranged(before, [1, 2, 0, 3]));
  await tabs(page).nth(0).focus();
  await page.keyboard.press("Enter");
  await expect(tabs(page).nth(0)).toHaveAttribute("aria-selected", "true");

  // The same off-strip drop, then a mouse click with no key between: the click lands on the tab it presses.
  const second = await centre(tabs(page).nth(1));
  const last = await centre(tabs(page).nth(3));
  await page.mouse.move(second.x, second.y);
  await page.mouse.down();
  await page.mouse.move(last.right - 4, last.y, { steps: 12 });
  await page.mouse.move(last.right - 4, last.y + 250, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => domOrder(page)).toEqual(rearranged(before, [1, 0, 3, 2]));
  await tabs(page).nth(2).click();
  await expect(tabs(page).nth(2)).toHaveAttribute("aria-selected", "true");
  await tabs(page).nth(0).click();
  await expect(tabs(page).nth(0)).toHaveAttribute("aria-selected", "true");

  const own = await centre(tabs(page).nth(1));
  await page.mouse.move(own.x, own.y);
  await page.mouse.down();
  await page.mouse.move(own.x + 30, own.y, { steps: 6 });
  await page.mouse.move(own.x, own.y, { steps: 6 });
  await page.mouse.up();
  await expect(tabs(page).nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(tabs(page).nth(1)).toHaveAttribute("aria-selected", "false");
});

test("a move is said once: a tab opened afterwards does not change what the strip said", async ({ page }) => {
  await openFour(page);
  await tabs(page).nth(0).focus();
  await pressShortcut(page, "tab.move:right");
  const said = page.getByRole("status").filter({ hasText: /^Moved / });
  await expect(said).toHaveText(/^Moved .+ to position 2 of 4/);
  const text = await said.textContent();
  await openNewTerminal(page);
  await expect(tabs(page)).toHaveCount(5);
  expect(await said.textContent()).toBe(text);
});
