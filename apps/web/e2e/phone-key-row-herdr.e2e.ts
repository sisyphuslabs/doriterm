import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { expectTouchTargets, key, keysBar, openPhoneTerminal, PHONE, showKeyboard } from "./phone-key-bar.ts";
import { stubSpeech } from "./speech-stub.ts";

test.use({ serviceWorkers: "block", ...PHONE });

/** The Herdr app's phone row (#2778): the paged keys on the left, the fixed actions on the right. */
const keysPill = (page: Page) => keysBar(page).getByRole("group", { name: "Keys", exact: true });
const actionsPill = (page: Page) => keysBar(page).getByRole("group", { name: "Actions", exact: true });
const card = (page: Page) => page.getByRole("group", { name: "Input card", exact: true });
const field = (page: Page) => page.getByLabel("Type into the terminal");
const pages = (page: Page) => keysPill(page).locator('[data-slot="terminal-keys-scroll"]');
const mic = (scope: Locator) => scope.getByRole("button", { name: /^Dictat/ });

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (found === null) throw new Error("not laid out");
  return found;
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`at 390 in ${colorScheme}: two pills in one row, the actions in Herdr's order`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme });
    await openPhoneTerminal(page, 390);
    await page.screenshot({ path: testInfo.outputPath("row.png") });

    const [keys, actions] = [await box(keysPill(page)), await box(actionsPill(page))];
    // One row: the two pills share a top and a height, the keys first, the actions at the right edge.
    expect(Math.abs(keys.y - actions.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(keys.height - actions.height)).toBeLessThanOrEqual(1);
    expect(keys.height).toBeGreaterThanOrEqual(44);
    expect(keys.x + keys.width).toBeLessThan(actions.x);
    expect(actions.x + actions.width).toBeLessThanOrEqual(390);

    const names = await actionsPill(page)
      .getByRole("button")
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
    expect(names).toEqual(["Return", "Hide keyboard", "Type in a field"]);
    await expectTouchTargets(keysBar(page));

    // The field is not part of the row: it waits for the card toggle.
    await expect(field(page)).toHaveCount(0);
    await expect(card(page)).toHaveCount(0);
  });
}

test("the key pill pages sideways and its dots follow the page in view", async ({ page }) => {
  await openPhoneTerminal(page, 390);
  const scroller = pages(page);
  const count = Number(await scroller.getAttribute("data-pages"));
  expect(count).toBeGreaterThan(1);
  await expect(scroller).toHaveAttribute("data-page", "1");
  await expect(keysPill(page).locator('[data-slot="page-dot"]')).toHaveCount(count);

  await scroller.evaluate((el) => el.scrollTo({ left: el.clientWidth }));
  await expect(scroller).toHaveAttribute("data-page", "2");
  // A page is the pill's width, so a swipe moves whole pages, not single keys.
  const width = await scroller.evaluate((el) => el.clientWidth);
  const widths = await scroller
    .locator('[data-slot="key-page"]')
    .evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().width)));
  expect(widths).toEqual(Array.from({ length: count }, () => width));
});

test("the card toggle opens the input card above the row, and Send keeps the #2767 rule", async ({
  page,
}, testInfo) => {
  const terminal = await openPhoneTerminal(page, 390);
  const toggle = actionsPill(page).getByRole("button", { name: "Type in a field", exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(card(page)).toBeVisible();
  await expect(field(page)).toBeFocused();
  expect((await box(card(page))).y + (await box(card(page))).height).toBeLessThanOrEqual((await box(keysPill(page))).y);

  await field(page).fill("echo card-");
  await page.keyboard.press("Enter");
  await field(page).pressSequentially("$((6*7))");
  // Enter only adds a line; nothing reaches the program before Send.
  await expect(field(page)).toHaveValue("echo card-\n$((6*7))");
  await page.screenshot({ path: testInfo.outputPath("card.png") });
  await card(page).getByRole("button", { name: "Send", exact: true }).click();
  await expect(field(page)).toHaveValue("");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(card(page)).toHaveCount(0);
  await expect(terminal).toContainText("card-");
});

// iOS raises the soft keyboard only for a focus made while the tap is being handled, so the card's field must take the
// focus inside the toggle's own click, not in a render after it (Q, 2026-11-26: "the keyboard does not come up").
test("the card toggle focuses the field inside the tap itself, so a phone raises its keyboard at once", async ({
  page,
}) => {
  await openPhoneTerminal(page, 390);
  const focusedInTap = await page.evaluate(() => {
    const toggle = document.querySelector<HTMLButtonElement>('[aria-label="Type in a field"]');
    if (toggle === null) throw new Error("no card toggle");
    toggle.click();
    return document.activeElement?.getAttribute("aria-label") ?? null;
  });
  expect(focusedInTap).toBe("Type into the terminal");
});

// The Herdr app's card (Q's reference shot, 2026-11-26): the mic and Enter sit at the card's end, Enter always pressable.
test("the open card holds the mic just before Enter, and Enter with an empty field presses Return", async ({
  page,
}) => {
  const terminal = await openPhoneTerminal(page, 390);
  const header = page.locator("header[data-titlebar]");
  await expect(mic(header)).toHaveCount(1);
  await page.keyboard.type("echo empty-$((3*3))");

  await actionsPill(page).getByRole("button", { name: "Type in a field", exact: true }).click();
  // One mic on the screen: the card's, in the place the Herdr app draws it.
  await expect(mic(header)).toHaveCount(0);
  await expect(mic(card(page))).toHaveCount(1);
  const enter = card(page).getByRole("button", { name: "Send", exact: true });
  await expect(enter).toBeEnabled();
  const [voice, send, input] = [await box(mic(card(page))), await box(enter), await box(field(page))];
  // Under the full-width field, at its end: the mic, then Enter, on one line.
  expect(Math.abs(voice.y + voice.height / 2 - (send.y + send.height / 2))).toBeLessThanOrEqual(1);
  expect(input.y + input.height).toBeLessThanOrEqual(voice.y);
  expect(voice.x + voice.width).toBeLessThanOrEqual(send.x);
  expect(Math.abs(send.x + send.width - (input.x + input.width))).toBeLessThanOrEqual(1);

  await enter.click();
  await expect(terminal).toContainText("empty-9");
  await actionsPill(page).getByRole("button", { name: "Type in a field", exact: true }).click();
  await expect(mic(header)).toHaveCount(1);
});

// Review of #2855: dictation takes the card's place, so the header has the mic again; Cancel gives the focus back to the
// mic that is on screen after it, the card's once the card returns, never to the page.
test("dictation from the card's mic keeps one mic in reach, and Cancel returns the focus to the card's mic", async ({
  page,
}) => {
  await stubSpeech(page);
  await openPhoneTerminal(page, 390);
  const header = page.locator("header[data-titlebar]");
  await actionsPill(page).getByRole("button", { name: "Type in a field", exact: true }).click();
  await mic(card(page)).click();
  await page.getByRole("button", { name: "Allow" }).click();
  const cancel = page.getByRole("button", { name: "Cancel dictation" });
  await expect(cancel).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await expect(mic(header)).toHaveCount(1);

  await cancel.click();
  await expect(card(page)).toBeVisible();
  await expect(mic(header)).toHaveCount(0);
  await expect(mic(card(page))).toBeFocused();
});

test("Return in the action pill is a terminal key: it reaches the program", async ({ page }) => {
  const terminal = await openPhoneTerminal(page, 390);
  await page.keyboard.type("echo row-$((5*5))");
  await actionsPill(page).getByRole("button", { name: "Return", exact: true }).click();
  await expect(terminal).toContainText("row-25");
});

test("the arrow key opens an inverted-T bubble over itself", async ({ page }, testInfo) => {
  const terminal = await openPhoneTerminal(page, 390);
  const toggle = keysPill(page).getByRole("button", { name: "Arrow keys", exact: true });
  await toggle.scrollIntoViewIfNeeded();
  await toggle.click();
  const pad = page.getByRole("group", { name: "Arrow keys", exact: true });
  await expect(pad).toBeVisible();
  const names = await pad
    .getByRole("button")
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
  expect(names).toEqual(["Up arrow", "Left arrow", "Down arrow", "Right arrow"]);
  const [bubble, anchor] = [await box(pad), await box(toggle)];
  expect(bubble.y + bubble.height).toBeLessThanOrEqual(anchor.y);
  const centre = anchor.x + anchor.width / 2;
  expect(centre).toBeGreaterThanOrEqual(bubble.x);
  expect(centre).toBeLessThanOrEqual(bubble.x + bubble.width);
  await expectTouchTargets(pad);
  await page.screenshot({ path: testInfo.outputPath("pad.png") });

  await page.keyboard.type("cat -v\r");
  await pad.getByRole("button", { name: "Left arrow", exact: true }).click();
  await page.keyboard.type("q\r");
  await expect(terminal).toContainText(/\^\[\[Dq/, { timeout: 15_000 });
});

test("with the soft keyboard down the row stays, so esc and Return need no keyboard", async ({ page }) => {
  await openPhoneTerminal(page, 390);
  await key(page, "Hide keyboard").click();
  await showKeyboard(page, 0);
  await expect(actionsPill(page).getByRole("button", { name: "Show keyboard", exact: true })).toBeVisible();
  await expect(keysPill(page).getByRole("button", { name: "Escape", exact: true })).toBeVisible();
  await expect(actionsPill(page).getByRole("button", { name: "Return", exact: true })).toBeVisible();
});
