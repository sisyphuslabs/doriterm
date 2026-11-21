import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { key, keysBar, openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

// The phone's keys as the owner drew them (#2604): one row at rest and on the keyboard, with no input bar; Chat swaps
// the row for a composer; the arrow pad pops up over the row, centred on its button.
test.use({ serviceWorkers: "block", ...PHONE });

const FIRST_KEYS = ["Control", "Shift", "Tab", "Escape"];
const PAD = ["Delete", "Up arrow", "Clear screen", "Left arrow", "Return", "Right arrow", "", "Down arrow", ""];

/** The row's first scrolling keys, the controls fixed after them, and whether a text field is in it. */
const row = (page: Page) =>
  keysBar(page).evaluate((bar) => {
    const scroller = bar.querySelector("[data-slot=terminal-keys-scroll]");
    const scrolling = [...(scroller?.querySelectorAll("button") ?? [])];
    const fixed = [...bar.querySelectorAll("button")].filter((button) => !scroller?.contains(button));
    return {
      first: scrolling.slice(0, 4).map((button) => button.getAttribute("aria-label") ?? ""),
      fixed: fixed.map((button) => button.getAttribute("aria-label") ?? ""),
      field: bar.querySelector("textarea, input") !== null,
    };
  });

test("at 390 the keys are one row at rest and on the keyboard, with no input bar (#2604)", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  expect(await row(page)).toEqual({
    first: FIRST_KEYS,
    fixed: ["Arrow keys", "Switch session", "Chat", "Hide keyboard"],
    field: false,
  });

  // The keys go to the terminal: cat -v shows Escape as ^[.
  await page.keyboard.type("cat -v\r");
  await key(page, "Escape").click();
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("^[", { timeout: 10_000 });

  await key(page, "Hide keyboard").click();
  await expect(key(page, "Show keyboard")).toBeVisible();
  expect(await row(page)).toEqual({
    first: FIRST_KEYS,
    fixed: ["Arrow keys", "Switch session", "Chat", "Show keyboard"],
    field: false,
  });
});

test("at 390 Chat swaps the row for a composer that sends a line, and closes back to the row (#2604)", async ({
  page,
}) => {
  const terminal = await openPhoneTerminal(page);
  await key(page, "Chat").click();
  const composer = page.getByRole("group", { name: "Chat" });
  await expect(composer).toBeVisible();
  await expect(keysBar(page)).toHaveCount(0);
  const field = composer.getByRole("textbox");
  await expect(field).toBeFocused();
  await expect(composer.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(composer.getByRole("button", { name: "Attach files" })).toBeVisible();

  await page.keyboard.type("echo sent-from-chat-$((6*7))");
  await composer.getByRole("button", { name: "Send" }).click();
  await expect(terminal).toContainText("sent-from-chat-42", { timeout: 10_000 });

  await composer.getByRole("button", { name: "Close chat" }).click();
  await expect(composer).toHaveCount(0);
  await expect(keysBar(page)).toBeVisible();
});

for (const state of ["rest", "keyboard"] as const) {
  test(`at 390 the arrow pad pops up over the row at ${state}, centred on its button (#2604)`, async ({ page }) => {
    const terminal = await openPhoneTerminal(page);
    await page.keyboard.type("cat -v\r");
    if (state === "rest") {
      await key(page, "Hide keyboard").click();
      await expect(key(page, "Show keyboard")).toBeVisible();
    }
    const toggle = key(page, "Arrow keys");
    await toggle.click();
    const pad = page.getByRole("group", { name: "Arrow keys" });
    await expect(pad).toBeVisible();
    const cells = await pad
      .locator(":scope > *")
      .evaluateAll((items) => items.map((item) => item.getAttribute("aria-label") ?? ""));
    expect(cells).toEqual(PAD);

    const [padBox, toggleBox, barBox] = await Promise.all([
      pad.boundingBox(),
      toggle.boundingBox(),
      keysBar(page).boundingBox(),
    ]);
    if (padBox === null || toggleBox === null || barBox === null) throw new Error("a box is missing");
    expect(Math.abs(padBox.x + padBox.width / 2 - (toggleBox.x + toggleBox.width / 2))).toBeLessThanOrEqual(2);
    expect(padBox.y + padBox.height).toBeLessThanOrEqual(barBox.y);

    await pad.getByRole("button", { name: "Up arrow" }).click();
    await pad.getByRole("button", { name: "Return" }).click();
    await expect(terminal).toContainText("^[[A", { timeout: 10_000 });
  });
}
