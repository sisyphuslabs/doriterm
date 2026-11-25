import type { Page } from "@playwright/test";
import { KEYS_BAR_HEIGHT } from "../src/workspace/phone-keys.tsx";
import { expect, test } from "./fixtures.ts";
import { expectTouchTargets, key, keysBar, openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

// With the soft keyboard up the keys bar is one row of two pills, and pressing "Type in a field" opens the Input card
// (Type field and Send) in a row of its own above the keys (#1551, #2778). Enter is one of the default keys.
test.use({ serviceWorkers: "block", ...PHONE });

const card = (page: Page) => page.getByRole("group", { name: "Input card", exact: true });
const field = (page: Page) => card(page).getByRole("textbox");

for (const width of [390, 320]) {
  test(`at ${width} the Type field and Send take a row of their own above the keys`, async ({ page }) => {
    const terminal = await openPhoneTerminal(page, width);
    const bar = keysBar(page);
    await expect(bar).toBeVisible();
    await key(page, "Type in a field").click();
    await expect(card(page)).toBeVisible();
    await expectTouchTargets(bar);
    await expectTouchTargets(card(page));
    const [box, cardBox, input, send, scroll] = await Promise.all([
      bar.boundingBox(),
      card(page).boundingBox(),
      field(page).boundingBox(),
      key(page, "Send").boundingBox(),
      page.locator('[data-slot="terminal-keys-scroll"]').boundingBox(),
    ]);
    if (box === null || cardBox === null || input === null || send === null || scroll === null) {
      throw new Error("no box");
    }
    // The input card sits above the key row and the field takes most of the bar's width.
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(box.y + 1);
    expect(input.y + input.height).toBeLessThanOrEqual(scroll.y + 1);
    expect(send.y + send.height).toBeLessThanOrEqual(scroll.y + 1);
    expect(input.width).toBeGreaterThan(box.width * 0.6);
    // The key pill shows one page of keys at once beside the three fixed action buttons.
    const shown = await page.locator('[data-slot="terminal-keys-scroll"]').evaluate((el) => {
      const edge = el.getBoundingClientRect();
      return [...el.querySelectorAll("button")]
        .filter((button) => {
          const rect = button.getBoundingClientRect();
          return rect.left >= edge.left - 1 && rect.right <= edge.right + 1;
        })
        .map((button) => button.getAttribute("aria-label"));
    });
    expect(shown.length).toBeGreaterThanOrEqual(width === 390 ? 4 : 3);
    expect(shown).toContain("Control");
    await expect(bar.getByRole("group", { name: "Actions", exact: true }).getByRole("button")).toHaveCount(3);
    const screen = await terminal.boundingBox();
    if (screen === null) throw new Error("no terminal box");
    expect(screen.y + screen.height).toBeLessThanOrEqual(cardBox.y + 1);
  });
}

test("the height the terminal keeps clear before the bar reports its own is the two-row bar's (#1555)", async ({
  page,
}) => {
  await openPhoneTerminal(page);
  const bar = keysBar(page);
  await expect(bar).toBeVisible();
  const box = await bar.boundingBox();
  if (box === null) throw new Error("no bar box");
  const rem = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
  expect(box.height).toBeCloseTo(Number.parseFloat(KEYS_BAR_HEIGHT) * rem, 0);
});

test("Enter from the key row ends the line the program reads", async ({ page }) => {
  const terminal = await openPhoneTerminal(page);
  await page.keyboard.type("echo row-return-$((20+22))");
  await keysBar(page).getByRole("button", { name: "Enter", exact: true }).click();
  await expect(terminal).toContainText("row-return-42", { timeout: 10_000 });
});
