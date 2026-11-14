import type { Page } from "@playwright/test";
import { KEYS_BAR_HEIGHT } from "../src/workspace/phone-keys.tsx";
import { expect, test } from "./fixtures.ts";
import { expectTouchTargets, key, keysBar, openPhoneTerminal, PHONE } from "./phone-key-bar.ts";

// With the soft keyboard up the keys bar is two rows in one panel: the Type field across the width with Send at its end,
// then the keys with the hide-keyboard key at the row's end (#1551). Enter is one of the default keys.
test.use({ serviceWorkers: "block", ...PHONE });

const field = (page: Page) => keysBar(page).getByRole("textbox");

for (const width of [390, 320]) {
  test(`at ${width} the Type field and Send take a row of their own above the keys`, async ({ page }) => {
    const terminal = await openPhoneTerminal(page, width);
    const bar = keysBar(page);
    await expect(bar).toBeVisible();
    await expectTouchTargets(bar);
    const [box, input, send, scroll] = await Promise.all([
      bar.boundingBox(),
      field(page).boundingBox(),
      key(page, "Send").boundingBox(),
      page.locator('[data-slot="terminal-keys-scroll"]').boundingBox(),
    ]);
    if (box === null || input === null || send === null || scroll === null) throw new Error("no box");
    // The field row sits above the key row and the field takes most of the bar's width.
    expect(input.y + input.height).toBeLessThanOrEqual(scroll.y + 1);
    expect(send.y + send.height).toBeLessThanOrEqual(scroll.y + 1);
    expect(input.width).toBeGreaterThan(box.width * 0.6);
    const shown = await page.locator('[data-slot="terminal-keys-scroll"]').evaluate((el) => {
      const edge = el.getBoundingClientRect();
      return [...el.querySelectorAll("button")]
        .filter((button) => button.getBoundingClientRect().right <= edge.right + 1)
        .map((button) => button.getAttribute("aria-label"));
    });
    // Beside the arrows fixed at the row's end (#2604) it shows its first keys, Escape leading.
    expect(shown.length).toBeGreaterThanOrEqual(width === 390 ? 3 : 1);
    expect(shown[0]).toBe("Escape");
    const screen = await terminal.boundingBox();
    if (screen === null) throw new Error("no terminal box");
    expect(screen.y + screen.height).toBeLessThanOrEqual(box.y + 1);
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
